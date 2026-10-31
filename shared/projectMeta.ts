/**
 * The five demo projects, each modelled on a real incident where an unpaid or
 * under-funded maintainer became everyone's security problem.
 *
 * This is the hand-written source of truth for ids, names and stories.
 * `npm run keys` merges generated testnet addresses into `shared/projects.json`;
 * regenerating keys never loses what is written here.
 *
 * Display names end with "(demo)" — these are not the real packages.
 */

export interface ProjectMeta {
  id: string
  name: string
  story: string
}

export const PROJECT_META: readonly ProjectMeta[] = [
  {
    id: 'tiny-tls',
    name: 'tiny-tls (demo)',
    story:
      'Heartbleed (2014): a buffer over-read in OpenSSL exposed the memory of two thirds of the web ' +
      'to anyone who asked. OpenSSL was maintained by a handful of volunteers on roughly $2,000 a ' +
      'year in donations, with one full-time developer.'
  },
  {
    id: 'stream-utils',
    name: 'stream-utils (demo)',
    story:
      'event-stream (2018): the burnt-out maintainer handed the package to a stranger who offered to ' +
      'help. The new owner shipped a payload that stole Bitcoin wallets. The package had ~2 million ' +
      'weekly downloads and zero funding.'
  },
  {
    id: 'log-helper',
    name: 'log-helper (demo)',
    story:
      'Log4Shell (2021): one line in Log4j gave remote code execution across millions of Java ' +
      'servers. Three unpaid volunteers spent their holidays patching it while the world waited.'
  },
  {
    id: 'color-text',
    name: 'color-text (demo)',
    story:
      'colors.js / faker.js (2022): the author, tired of large companies profiting from his unpaid ' +
      'work, pushed an infinite loop on purpose. Thousands of builds broke overnight — including ' +
      "Amazon's and Facebook's."
  },
  {
    id: 'compress-lite',
    name: 'compress-lite (demo)',
    story:
      'xz backdoor (2024): an attacker spent two years building trust as a helpful contributor, took ' +
      'co-maintainership of a compression library from an overwhelmed solo maintainer, and planted an ' +
      'SSH backdoor that nearly reached every Linux distribution.'
  }
]
