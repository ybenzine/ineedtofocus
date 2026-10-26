## Incident summary

**${title}** resolved. The on-call workflow is over its daily cap for `${alert}` in ${env} (${cap} runs with an agent session in 24 hours, #35), so it wrote this summary itself, without an agent session (#312).

- **Alert:** `${alert}` in ${env}
- **Fired:** ${started_at}
- **Resolved:** ${resolved_at}
- **Last agent decision:** ${action}
- **Cause, from that decision:** ${cause}
- **On-call runs:**
${runs}

${closing} The runbook is [`${runbook}`](../blob/main/${runbook}); the incident's earlier comments hold the agent's evidence.
