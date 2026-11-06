'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { authorityTarget, savedTarget, parseTarget } = require('./host');
const { withCancellation } = require('./ui');
const { abortable } = require('./cancellation');

// Per-authority keys prevent different windows from overwriting one shared map.
const storageKey = id => `host:${id}`;

function createHostPicker({ vscode, context, log, t, readFile = fs.readFile }) {
  function authority() {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust this workspace before connecting.'));
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (vscode.env.remoteName !== 'ssh-remote' || !folder?.uri.authority.startsWith('ssh-remote+')) {
      throw new Error(t('Open a remote folder with VS Code Remote-SSH before connecting.'));
    }
    return folder.uri.authority;
  }

  function saved(id) {
    const target = context.globalState.get(storageKey(id));
    return target === undefined ? context.globalState.get('hosts', {})[id] : target;
  }

  async function persist(id, target, signal) {
    if (signal.aborted) return;
    await context.globalState.update(storageKey(id), target);
  }

  async function resolveTarget(config, signal) {
    const id = config.authority || authority();
    const previous = saved(id);
    if (previous) {
      try {
        const target = savedTarget(previous, id);
        await persist(id, target, signal);
        if (typeof previous === 'string' && previous !== target.host) log.info(`Repaired legacy SSH target: ${target.host}`);
        return target;
      } catch (error) {
        log.warn(error.message);
      }
    }

    let inferred;
    try { inferred = authorityTarget(id); } catch (error) { log.warn(error.message); }
    const items = [];
    const known = new Set();
    const add = (target, description) => {
      if (target.host === inferred?.host && target.sshPort === undefined && inferred.sshPort !== undefined) {
        target = { ...target, sshPort: inferred.sshPort };
      }
      const key = `${target.host}:${target.sshPort || ''}`;
      if (known.has(key)) return;
      known.add(key);
      items.push({ label: target.host, description, target });
    };
    if (inferred) add(inferred, inferred.sshPort ? t('Current workspace · SSH port {0}', inferred.sshPort) : t('Current workspace'));
    if (config.host) {
      try { add(parseTarget(config.host), t('Configured default')); } catch (error) { log.warn(error.message); }
    }
    try {
      const contents = await abortable(readFile(config.configFile || path.join(os.homedir(), '.ssh', 'config'), { encoding: 'utf8', signal }), signal);
      for (const line of contents.split(/\r?\n/)) {
        const match = /^\s*Host(?:\s+|=)(.+)$/i.exec(line);
        if (!match) continue;
        for (const alias of match[1].replace(/\s+#.*$/, '').split(/\s+/)) {
          if (!/^[\w.-]+$/.test(alias)) continue;
          try { add(parseTarget(alias), t('Local SSH configuration')); } catch { /* Ignore patterns and invalid aliases. */ }
        }
      }
    } catch { /* OpenSSH still resolves Include/Match aliases typed manually. */ }
    if (signal.aborted) return;
    items.push({ label: t('Enter another SSH target…'), manual: true });
    return withCancellation(vscode, signal, async token => {
      const selected = await vscode.window.showQuickPick(items, {
        title: t('Choose the SSH target for this workspace'),
        placeHolder: t('Use the same server and remote user as Remote-SSH'),
        matchOnDescription: true, ignoreFocusOut: true
      }, token);
      if (!selected || signal.aborted) return;
      let target = selected.target;
      if (selected.manual) {
        const input = await vscode.window.showInputBox({
          title: t('SSH target'), prompt: t('Enter an SSH alias, user@host:port, or user@[IPv6]:port'),
          ignoreFocusOut: true,
          validateInput(value) {
            try { parseTarget(value); } catch { return t('Enter a valid SSH host and an optional port between 1 and 65535.'); }
          }
        }, token);
        if (!input || signal.aborted) return;
        target = parseTarget(input);
        if (target.host === inferred?.host && target.sshPort === undefined && inferred.sshPort !== undefined) {
          target.sshPort = inferred.sshPort;
        }
      }
      await persist(id, target, signal);
      return target;
    });
  }

  async function forget(id) {
    // A null tombstone prevents legacy fallback. Never rewrite the shared map:
    // concurrent windows could otherwise restore one another's deleted target.
    await context.globalState.update(storageKey(id), null);
  }

  return { authority, resolveTarget, forget, hasSaved: id => Boolean(saved(id)) };
}

module.exports = { createHostPicker, storageKey };
