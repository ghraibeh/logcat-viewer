/**
 * iOS Touch Input settings — where the user supplies an Apple signing identity so
 * the view-only iOS mirror can forward touches/keys. Injecting input on iOS needs a
 * signed on-device agent (WebDriverAgent / go-ios DeviceKit).
 *
 * Two ways to supply the identity:
 *  - Certificate + profile (default): the user already has a signing cert (`.p12`) +
 *    a device-scoped provisioning profile (`.mobileprovision`) from Xcode automatic
 *    signing or the Developer portal. Works for any team member — no Account-Holder /
 *    App Store Connect API access needed. We run `ui install` with them directly.
 *  - App Store Connect API key: Key ID + Issuer ID + `.p8`; go-ios generates the
 *    P12 + profile. Requires ASC API access (Account Holder only).
 *
 * The `.p8`/`.p12` are referenced by path (never copied); the P12 password stays in
 * this component's memory and is passed through provision(), never written to disk.
 */
import { useEffect, useState } from 'react'
import { methodReady, type IosAgent, type IosInputConfig, type IosSignMethod } from '@core/iosinput'

export function IosInputSettingsModal({
  serial,
  isIos,
  onClose
}: {
  serial: string | null
  isIos: boolean
  onClose: () => void
}) {
  const [cfg, setCfg] = useState<IosInputConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [agentUp, setAgentUp] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void window.androidlab.iosInput.getConfig().then(setCfg)
  }, [])

  useEffect(() => {
    const offP = window.androidlab.iosInput.onProgress((line) => setProgress((p) => [...p, line]))
    const offD = window.androidlab.iosInput.onDone((r) => {
      setResult(r)
      setBusy(false)
    })
    return () => {
      offP()
      offD()
    }
  }, [])

  if (!cfg) return null

  const set = (patch: Partial<IosInputConfig>): void => setCfg({ ...cfg, ...patch })
  const ready = methodReady(cfg)
  const base = (p: string): string => (p ? (p.split('/').pop() ?? p) : '')

  const pick = async (kind: 'p8' | 'p12' | 'profile'): Promise<void> => {
    const p = await window.androidlab.iosInput.chooseFile(kind)
    if (!p) return
    if (kind === 'p8') set({ p8Path: p })
    else if (kind === 'p12') set({ p12Path: p })
    else set({ profilePath: p })
  }
  const provision = async (): Promise<void> => {
    if (!serial) return
    await window.androidlab.iosInput.setConfig(cfg) // persist (minus the P12 password)
    setProgress([])
    setResult(null)
    setAgentUp(null)
    setBusy(true)
    void window.androidlab.iosInput.provision(serial, cfg) // live cfg carries the password
  }
  const checkStatus = async (): Promise<void> => {
    if (!serial) return
    setAgentUp(await window.androidlab.iosInput.status(serial))
  }
  const copyLog = async (): Promise<void> => {
    const text = [...progress, result?.message ?? ''].filter(Boolean).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  const close = (): void => {
    if (busy) void window.androidlab.iosInput.cancel()
    onClose()
  }

  return (
    <div className="scrim" onMouseDown={() => !busy && onClose()}>
      <div className="ios-input-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="iim-bar">
          <span className="iim-title">iOS Touch Input — signing</span>
          <span className="grow" />
          <button className="start" onClick={close}>
            {busy ? 'Cancel' : 'Close'}
          </button>
        </div>

        <div className="iim-body">
          {!isIos ? (
            <div className="iim-warn">Select a connected iPhone/iPad to provision and install the input agent.</div>
          ) : null}

          <div className="iim-methods">
            {(
              [
                ['manual', 'Certificate + profile'],
                ['asc', 'App Store Connect key']
              ] as Array<[IosSignMethod, string]>
            ).map(([m, label]) => (
              <button
                key={m}
                className={`iim-method${cfg.method === m ? ' active' : ''}`}
                onClick={() => set({ method: m })}
                disabled={busy}
              >
                {label}
              </button>
            ))}
          </div>

          {cfg.method === 'manual' ? (
            <>
              <p className="iim-help">
                Provide a signing certificate and a provisioning profile that includes this device — works for any team
                member (no Account-Holder / App Store Connect access). Easiest: in <b>Xcode</b>, let automatic signing
                provision the device once, then export your <b>Apple Development</b> cert from <i>Keychain Access → Export → .p12</i>{' '}
                and use the generated <b>.mobileprovision</b>. (Or create both at <i>developer.apple.com → Certificates, IDs &amp; Profiles</i>.)
                Files are referenced by path; the P12 password is used once and never saved.
              </p>
              <label className="iim-row">
                <span>Certificate (.p12)</span>
                <span className="iim-file">
                  <button onClick={() => void pick('p12')}>Choose…</button>
                  <span className={`iim-filename${cfg.p12Path ? '' : ' dim'}`}>{base(cfg.p12Path) || 'no file selected'}</span>
                </span>
              </label>
              <label className="iim-row">
                <span>P12 password</span>
                <input
                  type="password"
                  value={cfg.p12Password}
                  onChange={(e) => set({ p12Password: e.target.value })}
                  placeholder="(blank if the .p12 has no password)"
                />
              </label>
              <label className="iim-row">
                <span>Profile</span>
                <span className="iim-file">
                  <button onClick={() => void pick('profile')}>Choose…</button>
                  <span className={`iim-filename${cfg.profilePath ? '' : ' dim'}`}>
                    {base(cfg.profilePath) || 'no .mobileprovision selected'}
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <p className="iim-help">
                Provide an <b>App Store Connect API key</b> (<i>App Store Connect → Users and Access → Integrations → App Store
                Connect API → +</i>). Copy the <b>Key ID</b> and <b>Issuer ID</b>, download the <b>.p8</b> once, and select it below.
                Requires ASC API access — <b>Account Holder only</b>. The .p8 is a private key; only its path is stored.
              </p>
              <label className="iim-row">
                <span>Key ID</span>
                <input value={cfg.keyId} onChange={(e) => set({ keyId: e.target.value })} placeholder="e.g. ABC123DEFG" spellCheck={false} />
              </label>
              <label className="iim-row">
                <span>Issuer ID</span>
                <input value={cfg.issuerId} onChange={(e) => set({ issuerId: e.target.value })} placeholder="e.g. 69a6de70-…" spellCheck={false} />
              </label>
              <label className="iim-row">
                <span>API key (.p8)</span>
                <span className="iim-file">
                  <button onClick={() => void pick('p8')}>Choose…</button>
                  <span className={`iim-filename${cfg.p8Path ? '' : ' dim'}`}>{base(cfg.p8Path) || 'no file selected'}</span>
                </span>
              </label>
              <label className="iim-row">
                <span>Bundle ID</span>
                <input value={cfg.bundleId} onChange={(e) => set({ bundleId: e.target.value })} placeholder="com.you.uiagent" spellCheck={false} />
              </label>
            </>
          )}

          <label className="iim-row">
            <span>Agent</span>
            <select value={cfg.agent} onChange={(e) => set({ agent: e.target.value as IosAgent })}>
              <option value="wda">WebDriverAgent (recommended)</option>
              <option value="devicekit">DeviceKit (advanced)</option>
            </select>
          </label>

          <div className="iim-actions">
            <button
              className="start"
              onClick={() => void provision()}
              disabled={busy || !ready || !isIos}
              title={!ready ? 'Fill in the fields for this method first' : !isIos ? 'Select an iOS device' : ''}
            >
              {busy ? 'Installing…' : cfg.provisioned ? 'Re-install agent' : 'Install input agent'}
            </button>
            <button onClick={() => void checkStatus()} disabled={busy || !isIos}>
              Check agent
            </button>
            {agentUp != null ? (
              <span className={`iim-badge ${agentUp ? 'ok' : 'bad'}`}>{agentUp ? 'agent reachable' : 'agent not reachable'}</span>
            ) : cfg.provisioned ? (
              <span className="iim-badge ok">installed</span>
            ) : null}
          </div>

          {busy || progress.length > 0 || result ? (
            <div className="iim-log">
              <div className="iim-log-head">
                <span className="iim-log-title">
                  {busy ? <span className="iim-spinner" /> : null}
                  Log
                </span>
                <button className="iim-copy" onClick={() => void copyLog()} disabled={progress.length === 0 && !result}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="iim-log-body">
                {progress.map((l, i) => (
                  <div key={i} className="iim-log-line">
                    {l}
                  </div>
                ))}
                {result ? <div className={`iim-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
