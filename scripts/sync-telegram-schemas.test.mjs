import assert from 'node:assert/strict'
import test from 'node:test'
import { cookieFromSetCookie, decodeHtml, parseArgs, parseSchemaPage } from './sync-telegram-schemas.mjs'

test('extracts selected layer, advertised layers, and plain TL from Telegram HTML', () => {
  const html = `<!doctype html><a class="dropdown-toggle">Layer 3 <b></b></a>
    <a href="?layer=1">one</a><a href="?layer=3">three</a>
    <pre class="page_scheme"><code><a href="/constructor/boolFalse">boolFalse</a>#bc799737 = <a>Bool</a>;
---functions---
messages.<a>getHistory</a>#dcbb8260 peer:<a>InputPeer</a> = <a>messages.Messages</a>;</code></pre>`
  const parsed = parseSchemaPage(html)
  assert.equal(parsed.reportedLayer, 3)
  assert.deepEqual(parsed.advertisedLayers, [1, 3])
  assert.equal(parsed.schema, 'boolFalse#bc799737 = Bool;\n---functions---\nmessages.getHistory#dcbb8260 peer:InputPeer = messages.Messages;\n')
})

test('decodes named, decimal, and hexadecimal HTML entities', () => {
  assert.equal(decodeHtml('&lt;&gt;&amp;&quot;&apos;&nbsp;&#35;&#x41;'), '<>&"\' #A')
})

test('parses dense sync CLI options and pnpm argument separators', () => {
  assert.deepEqual(parseArgs(['--', '--from', '199', '--to', '225', '--concurrency', '8', '--retries', '2', '--dense']), {
    out: new URL('../packages/mtproto/schema/api', import.meta.url).pathname,
    from: 199,
    to: 225,
    concurrency: 8,
    retries: 2,
    advertisedOnly: false,
  })
})

test('rejects pages without a TL code block', () => {
  assert.throws(() => parseSchemaPage('<html>no schema</html>'), /page_scheme/)
})

test('keeps only the cookie pair from Telegram layer redirects', () => {
  assert.equal(cookieFromSetCookie('stel_dev_layer=3; expires=Wed, 21 Jul 2027 21:01:35 GMT; path=/; HttpOnly'), 'stel_dev_layer=3')
  assert.equal(cookieFromSetCookie(null), null)
})
