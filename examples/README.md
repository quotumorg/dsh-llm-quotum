# profile overlays

apply the bundle patch first, then one of these overlays. JSON is valid YAML.
row config is replaced as a whole; restate every nondefault key on an existing row.

`seat-only.cordis.patch.yml` selects the primary route for the agent.
`payg-auxiliary.cordis.patch.yml` enables PAYG without moving the main agent.
`payg-only.cordis.patch.yml` disables the seat and selects PAYG for the agent.

`router-workers.cordis.patch.yml` mounts two isolated instances: the main
agent stays on `quotum-seat`; `quotum-workers` sends only `QUOTUM_DAYKEY_WORKERS`
to the same seat endpoint. Export `QUOTUM_SEAT_KEY` and a separate day key in
`QUOTUM_DAYKEY_WORKERS`, then refresh the latter when it expires at the bell.
Each worker call must select `{ provider: 'quotum-workers', model: 'deepseek-v4-pro' }`.
The patch registers routes; it does not spawn workers or enforce orchestration.
Day-key budget/expiry is enforced by the
issuer. The adapter does not create, top up, or refresh keys.
