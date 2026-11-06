'use strict';

/** Bridges AbortSignal to VS Code's cancellation token and always frees it. */
async function withCancellation(vscode, signal, run) {
  const source = new vscode.CancellationTokenSource();
  const cancel = () => source.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await run(source.token);
  } finally {
    signal.removeEventListener('abort', cancel);
    source.dispose();
  }
}

module.exports = { withCancellation };
