The on-call workflow (#35) merged fix PR #${pr} for incident #${incident} as `${sha}`, after the reviewer App's approval and green CI. That deploys it to dev, where this alert fired. The workflow now waits for the alert to resolve.

Prod gets the fix with the next prod deploy, which the lead asks Yacine for as usual (`_docs/process.md` §8). There's no separate ask: the alert fired on dev, not on prod. If prod shows the same problem, its own alert opens its own incident, and that one asks for the prod deploy.
