import { spawn } from 'cross-worker-bare-kit'

import { WorkerClient } from '@holepunchto/bare-translations/client'

export const translationsWorker = new WorkerClient()

export const initTranslationsWorklet = (storagePath) => {
  translationsWorker.initialize({
    spawn,
    filename: 'keet:/translations.bundle',
    requireSource: () => require('./translations.bundle.js'),
    args: [storagePath]
  })
}
