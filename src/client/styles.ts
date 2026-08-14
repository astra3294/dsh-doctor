/*
 * DSH Doctor client styles.
 *
 * Every color, border, and background resolves through the DeepSeek Harness
 * `--dsw-*` design tokens (defined globally on `body` / `body[data-ds-dark-theme]`
 * by dsh-client-ui-theme). This keeps Doctor on the same palette, radii, and
 * light/dark switch as the rest of the WebUI — no hardcoded hex, no independent
 * `prefers-color-scheme` override.
 */
const CSS = `
.dshDoctorVisuallyHidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* rc.6 renders a default gear for unknown settings-section ids. */
[data-dsh-doctor-nav=true]>[data-dsh-doctor-fallback-icon=true]{display:none!important}
[data-dsh-doctor-nav-icon=true]{display:block;flex:none;width:16px;height:16px;color:inherit}

/* Exact geometry used by the built-in settings trigger in rc.6. */
.dshDoctorSidebarButton{box-sizing:border-box;position:relative;display:inline-flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:20px;cursor:pointer;overflow:hidden}
.dshDoctorSidebarButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dshDoctorSidebarButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshDoctorSidebarButton[data-wide=false]{justify-content:center;gap:0;width:36px;height:36px;margin:4px 0;border-radius:50%;padding:0}
.dshDoctorSidebarLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDoctorSidebarStatus{margin-left:auto;margin-right:8px}
.dshDoctorSidebarButton[data-wide=false] .dshDoctorSidebarStatus{position:absolute;top:5px;right:5px;margin-left:0}

/* Status summary: a native settings row, not a second dark panel. */
.dshDoctorSummary{display:grid;grid-template-columns:32px minmax(0,1fr) 8px;gap:12px;align-items:start}
.dshDoctorSummaryIcon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshDoctorSummaryCopy{min-width:0}
.dshDoctorSummary h3{margin:0 0 2px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dshDoctorSummary p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshDoctorSummaryState{margin-top:7px}
.dshDoctorStatusSurface{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent}
.dshDoctorModal{box-sizing:border-box;width:520px;max-width:calc(100vw - 48px)}
.dshDoctorModal .dshDoctorSummary{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}

/* Compact textual counts follow the restrained metadata treatment in settings. */
.dshDoctorCounts{display:flex;flex-wrap:wrap;align-items:center;gap:0;margin-top:12px;font-variant-numeric:tabular-nums}
.dshDoctorCount{display:inline-flex;align-items:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshDoctorCount+.dshDoctorCount::before{content:'·';margin:0 8px;color:var(--dsw-alias-label-caption)}
.dshDoctorCount[data-level=error]{color:var(--dsw-alias-state-error-primary)}
.dshDoctorCount[data-level=warning]{color:var(--dsw-alias-state-warn-label)}

/* Action rows */
.dshDoctorActions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}

/* Progress */
.dshDoctorProgress{margin-top:12px;padding:10px 12px;border-left:2px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshDoctorProgress ol{margin:0;padding-left:18px}
.dshDoctorProgress li{padding:2px 0;color:var(--dsw-alias-label-tertiary)}
.dshDoctorProgress li[data-active=true]{color:var(--dsw-alias-label-primary);font-weight:500}

/* Error callout */
.dshDoctorError{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);word-break:break-word}

/* Secondary decisions use a divider, matching built-in setting rows. */
.dshDoctorNotice{margin-top:16px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshDoctorNotice h3{margin:0 0 8px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}

/* Issue / checkpoint lists */
.dshDoctorIssueList,.dshDoctorHistoryList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.dshDoctorIssue{display:grid;grid-template-columns:12px 1fr;gap:8px;align-items:start;padding:10px 0}
.dshDoctorIssue+.dshDoctorIssue{border-top:1px solid var(--dsw-alias-border-l1)}
.dshDoctorIssueDot{display:inline-flex;margin-top:6px}
.dshDoctorIssueDotInfo{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption)}
.dshDoctorIssue strong{display:block;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dshDoctorIssue p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshDoctorEmpty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}

/* Mirrors ModelsSettingsSection in the installed rc.6 UI package. */
.dshDoctorSection{display:flex;flex-direction:column;gap:12px;max-width:720px}
.dshDoctorSectionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshDoctorSectionTitle{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.dshDoctorSectionDesc{margin:2px 0 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.dshDoctorSettingsGroup{padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshDoctorSettingsGroup h3{margin:0 0 8px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}

/* Version stamp */
.dshDoctorVersion{margin:6px 0 0;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}

/* Checkpoint history rows */
.dshDoctorHistoryRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;padding:8px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshDoctorHistoryRow+.dshDoctorHistoryRow{border-top:1px solid var(--dsw-alias-border-l1)}
.dshDoctorHistoryMeta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Failure banner */
.dshDoctorBanner{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-primary)}
.dshDoctorBannerText{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px}
.dshDoctorBannerActions{display:flex;align-items:center;gap:6px}
.dshDoctorBanner button{white-space:nowrap}

/* Emergency floating entry (shell overlay layer; appears only when broken) */
.dshDoctorFloating{pointer-events:auto;position:fixed;right:20px;bottom:20px;z-index:40;display:grid;place-items:center;width:40px;height:40px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-state-error-primary);cursor:pointer;box-shadow:var(--dsw-shadow-lv2)}
.dshDoctorFloating:hover{background:var(--dsw-alias-button-floating-hover)}
.dshDoctorFloating:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}

@media (max-width:600px){.dshDoctorModal{max-width:calc(100vw - 24px)}.dshDoctorSectionHead{flex-direction:column}.dshDoctorBanner{align-items:flex-start}.dshDoctorBannerActions{flex-direction:column;align-items:stretch}}
`

export function installDoctorStyles(): () => void {
  const id = 'dsh-doctor/styles'
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-doctor'
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
