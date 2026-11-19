// Registers Brave and Google as search sources in the project and stores their keys (encrypted by the engine).
import { signIn, engine, signOut } from './pam.mjs';
import { readFileSync } from 'node:fs';
const keys = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await signIn();
const brave = await engine('discovery', 'POST', '/v1/sources', {
  name: 'Web search (Brave Search API)', kind: 'search_json', baseUrl: 'https://api.search.brave.com/res/v1/web/search',
  config: { queryParam: 'q', params: { count: '20', safesearch: 'off' }, itemsPath: 'web.results', urlField: 'url', titleField: 'title', metadataFields: ['description', 'age', 'page_age', 'language'], linkScope: 'any' },
  accessTerms: 'Brave Search API results: links and snippets for research; pages are fetched and preserved separately.', reuse: 'citation_only', rateLimit: { minIntervalMs: 1100 }, idempotencyKey: 'hn-search-brave' }, 'research');
await engine('discovery', 'POST', `/v1/sources/${brave.id}/credential`, { header: 'X-Subscription-Token', value: keys.BRAVE_SEARCH_API_KEY, authorizationNote: 'Owner-provided Brave Search API key for Hezar Nafar Poshteshe research' }, 'administration');
const google = await engine('discovery', 'POST', '/v1/sources', {
  name: 'Web search (Google Programmable Search)', kind: 'search_json', baseUrl: 'https://www.googleapis.com/customsearch/v1',
  config: { queryParam: 'q', params: { cx: keys.GOOGLE_SEARCH_ENGINE_ID, num: '10' }, itemsPath: 'items', urlField: 'link', titleField: 'title', metadataFields: ['snippet', 'displayLink'], linkScope: 'any',
    pagination: { offset: { offsetParam: 'start', limitParam: 'num', limit: 10 } } },
  accessTerms: 'Google Custom Search JSON API results: links and snippets for research; pages are fetched and preserved separately.', reuse: 'citation_only', rateLimit: { minIntervalMs: 1100 }, idempotencyKey: 'hn-search-google' }, 'research');
await engine('discovery', 'POST', `/v1/sources/${google.id}/credential`, { header: 'X-goog-api-key', value: keys.GOOGLE_SEARCH_API_KEY, authorizationNote: 'Owner-provided Google Custom Search API key for Hezar Nafar Poshteshe research' }, 'administration');
console.log('brave source', brave.id, '| google source', google.id);
// One test query each, for a name from the official list.
for (const [label, s] of [['brave', brave], ['google', google]]) {
  const attempt = await engine('discovery', 'POST', '/v1/discovery/searches', { sourceId: s.id, query: 'علی اباذری جان باخته دی ۱۴۰۴', maxPages: 1, maxItems: 10, idempotencyKey: `hn-test-search-${label}` });
  console.log(label, 'attempt', attempt.id, attempt.state);
}
await signOut();
