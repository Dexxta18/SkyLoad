import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupEnv } from './helpers.js'

setupEnv()
const { parseLink, driveDownloadUrl } = await import('../src/server/links.js')
const { assertAllowedUrl, fileNameFromDisposition, fileNameFromUrl, makeSafeLookup } = await import('../src/server/lib/safe-fetch.js')

test('recognises Google Drive share links', () => {
  assert.deepEqual(parseLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), {
    kind: 'gdrive',
    id: '1AbCdEfGhIjKlMnOp',
    isFolder: false,
    resourceKey: undefined,
    url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing',
  })
  assert.equal((parseLink('https://drive.google.com/drive/folders/1FolderIdXyz123?usp=drive_link') as { isFolder: boolean }).isFolder, true)
  assert.equal((parseLink('https://drive.google.com/drive/u/0/folders/1FolderIdXyz123') as { id: string }).id, '1FolderIdXyz123')
  const open = parseLink('https://drive.google.com/open?id=1OpenIdAbcdef12&resourcekey=0-key')
  assert.equal(open.kind, 'gdrive')
  assert.equal((open as { isFolder: null }).isFolder, null)
  assert.equal((open as { resourceKey: string }).resourceKey, '0-key')
  assert.equal(parseLink('https://docs.google.com/document/d/1DocIdAbcdefgh/edit').kind, 'gdrive')
})

test('turns Dropbox share links into direct downloads', () => {
  assert.deepEqual(parseLink('https://www.dropbox.com/scl/fi/abc/report.pdf?rlkey=xyz&dl=0'), { kind: 'http', url: 'https://www.dropbox.com/scl/fi/abc/report.pdf?rlkey=xyz&dl=1' })
})

test('treats other links as plain downloads and rejects non-links', () => {
  assert.deepEqual(parseLink('  https://example.com/files/a.zip '), { kind: 'http', url: 'https://example.com/files/a.zip' })
  assert.throws(() => parseLink('not a link'), /does not look like a link/)
  assert.throws(() => parseLink('ftp://example.com/a.zip'), /Only http/)
  assert.throws(() => parseLink('file:///etc/passwd'), /Only http/)
})

test('builds the public Drive download URL', () => {
  assert.equal(driveDownloadUrl('abc123', 'rk'), 'https://drive.usercontent.google.com/download?id=abc123&export=download&confirm=t&resourcekey=rk')
})

test('reads file names from headers and URLs', () => {
  assert.equal(fileNameFromDisposition(`attachment; filename*=UTF-8''R%C3%A9sum%C3%A9%20final.pdf`), 'Résumé final.pdf')
  assert.equal(fileNameFromDisposition('attachment; filename="report 2026.pdf"'), 'report 2026.pdf')
  assert.equal(fileNameFromDisposition('attachment; filename=plain.txt'), 'plain.txt')
  assert.equal(fileNameFromDisposition('inline'), undefined)
  assert.equal(fileNameFromUrl(new URL('https://example.com/a/b/My%20File.iso?x=1')), 'My File.iso')
  assert.equal(fileNameFromUrl(new URL('https://example.com/')), 'example.com')
})

test('blocks private and internal addresses', () => {
  for (const url of [
    'http://127.0.0.1/x',
    'http://localhost:3000/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://metadata.google.internal/',
    'http://[::1]/',
    'http://db:5432/',
  ]) {
    assert.throws(() => assertAllowedUrl(new URL(url), false), /private or internal/, url)
  }
  assert.throws(() => assertAllowedUrl(new URL('https://user:pass@example.com/'), false), /username or password/)
  assert.doesNotThrow(() => assertAllowedUrl(new URL('https://example.com/file.zip'), false))
  assert.doesNotThrow(() => assertAllowedUrl(new URL('http://127.0.0.1/x'), true))
})

test('blocks hostnames that resolve to private addresses at connect time', async () => {
  const lookupWith = (address: string) =>
    new Promise<{ err: unknown; address?: unknown }>((resolve) => {
      const lookup = makeSafeLookup(false, (_host, _opts, cb) => cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]))
      lookup('example.test', {}, (err, addr) => resolve({ err, address: addr }))
    })
  assert.match(String((await lookupWith('10.1.2.3')).err), /private or internal/)
  assert.match(String((await lookupWith('169.254.169.254')).err), /private or internal/)
  assert.match(String((await lookupWith('::1')).err), /private or internal/)
  const ok = await lookupWith('93.184.216.34')
  assert.equal(ok.err, null)
  assert.equal(ok.address, '93.184.216.34')
})
