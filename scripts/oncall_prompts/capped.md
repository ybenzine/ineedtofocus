⛔ Needs Yacine: the on-call workflow reached its daily cap for `${alert}` in ${env}: ${cap} runs in 24 hours (#35). It won't start the agent again for this alert and environment until the oldest of those runs is a day old, so the alert's repeats and resolution won't be handled meanwhile.

Please look at the alert in Grafana and follow `${runbook}` by hand. A flapping alert, or dispatches nobody sent from Grafana (check the runs' **Sent by** line), is the likely cause. The cap keeps the paid sessions bounded; the Anthropic spend limit is the backstop.
