// Remove the build output once, before tsup runs. tsup builds the server and
// browser bundles concurrently, so letting one of them `clean` the shared dist/
// would race with the other's writes — we clean here instead.
import { rmSync } from 'node:fs'

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true })
