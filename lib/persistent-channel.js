import { Duplex } from 'node:stream'

/** Open a raw ssh2 command stream without collecting, timing out, or replaying it. */
export function openSsh2ExecChannel(client, command, opts = {}) {
  return new Promise((resolve, reject) => {
    const opened = (error, stream) => {
      if (error) return reject(new Error('ssh helper channel open failed: ' + ((error && error.message) || error)))
      if (opts.isCurrent && !opts.isCurrent()) {
        try { stream.close() } catch {}
        return reject(new Error('ssh target changed while opening helper channel'))
      }
      let code = null
      let signal = null
      let transportError = null
      const done = new Promise((resolveDone) => {
        stream.once('exit', (exitCode, exitSignal) => { code = exitCode ?? null; signal = exitSignal || null })
        stream.once('error', (err) => { transportError = err })
        stream.once('close', () => resolveDone({ code, signal, error: transportError }))
      })
      resolve({
        readable: stream,
        writable: stream,
        stderr: stream.stderr,
        done,
        close: () => { try { stream.close() } catch {} },
        destroy: () => { try { stream.destroy() } catch {} },
      })
    }
    try { client.exec(String(command), {}, opened) } catch (error) {
      reject(new Error('ssh helper channel open failed: ' + ((error && error.message) || error)))
    }
  })
}

/** Adapt an OpenSSH child process's separate stdio pipes to one duplex channel. */
export function wrapSshChildChannel(child) {
  let resolveDone
  let code = null
  let signal = null
  let transportError = null
  let settled = false
  const done = new Promise((resolve) => { resolveDone = resolve })
  const finish = () => {
    if (settled) return
    settled = true
    resolveDone({ code, signal, error: transportError })
  }
  const channel = new Duplex({
    read() { child.stdout.resume() },
    write(chunk, encoding, callback) {
      try { child.stdin.write(chunk, encoding, callback) } catch (error) { callback(error) }
    },
    final(callback) { try { child.stdin.end(callback) } catch (error) { callback(error) } },
    destroy(error, callback) {
      try { child.kill() } catch { /* already exited */ }
      callback(error)
    },
  })
  channel.stderr = child.stderr
  channel.done = done
  channel.close = () => { try { channel.destroy() } catch { /* already closed */ } }
  child.stdout.on('data', (chunk) => { if (!channel.push(chunk)) child.stdout.pause() })
  child.stdout.on('end', () => channel.push(null))
  child.once('error', (error) => {
    transportError = error
    channel.destroy(error)
    finish()
  })
  child.once('close', (exitCode, exitSignal) => {
    code = exitCode ?? null
    signal = exitSignal || null
    if (!channel.destroyed) channel.push(null)
    finish()
  })
  return channel
}
