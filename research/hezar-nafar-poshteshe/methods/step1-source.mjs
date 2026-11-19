import { signIn, engine, signOut } from './pam.mjs';
const { purposes } = await signIn();
console.log('purposes:', purposes.map((p) => p.name ?? p).join(', '));
const urls = [
  'https://www.mehrnews.com/news/6737115/',
  'https://ensafnews.com/632856/',
  'https://www.jamaran.news/%D8%A8%D8%AE%D8%B4-%D8%B3%DB%8C%D8%A7%D8%B3%D8%AA-12/1696486-%D8%A7%D8%B3%D8%A7%D9%85%DB%8C-%D9%85%D8%B4%D8%AE%D8%B5%D8%A7%D8%AA-%D8%AC%D8%A7%D9%86-%D8%A8%D8%A7%D8%AE%D8%AA%D9%87-%D8%AD%D9%88%D8%A7%D8%AF%D8%AB-%D8%AF%DB%8C-%D9%85%D8%A7%D9%87-%D9%81%D9%87%D8%B1%D8%B3%D8%AA',
  'https://www.irib-news.ir/fa/news/5703568/',
];
const source = await engine('discovery', 'POST', '/v1/sources', {
  name: 'Official list of people killed, Dey 1404 (President\'s office, republished by Iranian news agencies)', kind: 'file_list', baseUrl: 'https://www.mehrnews.com/',
  config: { urls, allowedHosts: ['www.mehrnews.com', 'mehrnews.com', 'ensafnews.com', 'www.ensafnews.com', 'www.jamaran.news', 'jamaran.news', 'www.irib-news.ir', 'irib-news.ir'] },
  accessTerms: 'Public government announcement republished by news agencies; captured for documentation and verification. The national ID fragments it contains are sensitive and must not be republished.',
  reuse: 'citation_only', rateLimit: { minIntervalMs: 3000 }, idempotencyKey: 'hn-official-list-source',
});
console.log('source:', source.id, source.state ?? '', source.ref);
const run = await engine('discovery', 'POST', '/v1/collections', { sourceId: source.id, level: 'bytes', maxItems: 20, idempotencyKey: 'hn-official-list-run-1' });
console.log('run:', run.id, run.state);
await signOut();
