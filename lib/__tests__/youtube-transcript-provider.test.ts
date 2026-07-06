import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchYouTubeTranscript,
  TranscriptProviderError,
} from '../youtube-transcript-provider';

function withMockFetch(
  mockFetch: typeof fetch,
  run: () => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

// Minimal YouTube watch page HTML with INNERTUBE_API_KEY embedded
// (our provider scrapes this before calling InnerTube)
const FAKE_WATCH_PAGE = `
  <html><body><script>
    ytcfg.set({"INNERTUBE_API_KEY":"AIzaFakeKey","INNERTUBE_CLIENT_VERSION":"2.20250326","VISITOR_DATA":"fakeVisitor"});
  </script></body></html>
`;

test('fetchYouTubeTranscript returns transcript when Android client succeeds', async () => {
  await withMockFetch(
    async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

      // Page scrape request
      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      // InnerTube player request — return caption tracks
      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
                {
                  baseUrl: 'https://captions.test/fr',
                  languageCode: 'fr',
                  name: { simpleText: 'Francais' },
                  kind: 'asr',
                },
              ],
            },
          },
        }));
      }

      // Caption track fetch — return XML with <p> format (milliseconds)
      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="420" d="4200">hello &amp; welcome</p>
          <p t="5100" d="1500">&#39;quoted&#39;</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result, 'Should return a result');
      assert.equal(result.language, 'en');
      assert.deepEqual(result.availableLanguages, ['en', 'fr']);
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].text, 'hello & welcome');
      assert.equal(result.segments[0].start, 0.42);
      assert.equal(result.segments[0].duration, 4.2);
      assert.equal(result.segments[1].text, "'quoted'");
    }
  );
});

test('fetchYouTubeTranscript prefers requested language', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
                {
                  baseUrl: 'https://captions.test/fr',
                  languageCode: 'fr',
                  name: { simpleText: 'Francais' },
                },
              ],
            },
          },
        }));
      }

      // Should request French since we asked for it
      if (url.startsWith('https://captions.test/fr')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">bonjour</p>
        </body></timedtext>`);
      }

      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">hello</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123', 'fr');

      assert.ok(result);
      assert.equal(result.language, 'fr');
      assert.equal(result.segments[0].text, 'bonjour');
    }
  );
});

test('fetchYouTubeTranscript returns null when video has no captions', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        // No captions object at all
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');
      assert.equal(result, null);
    }
  );
});

test('fetchYouTubeTranscript tries next client when one is rate-limited', async () => {
  let innerTubeCallCount = 0;

  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        innerTubeCallCount++;
        // First call (Android) returns 429 rate limit
        if (innerTubeCallCount === 1) {
          return new Response('Too Many Requests', { status: 429 });
        }
        // Second call (Web) succeeds
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        }));
      }

      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><timedtext><body>
          <p t="0" d="1000">hello from fallback</p>
        </body></timedtext>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result, 'Should succeed via fallback client');
      assert.equal(result.segments[0].text, 'hello from fallback');
      // Should have tried at least 2 InnerTube calls (Android failed, Web succeeded)
      assert.ok(innerTubeCallCount >= 2, `Expected >= 2 InnerTube calls, got ${innerTubeCallCount}`);
    }
  );
});

test('fetchYouTubeTranscript parses legacy <text> XML format', async () => {
  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        }));
      }

      // Return legacy XML format (seconds, <text> tags)
      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?>
          <transcript>
            <text start="0.42" dur="4.2">hello &amp; welcome</text>
            <text start="5.1" dur="1.5">goodbye</text>
          </transcript>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result);
      assert.equal(result.segments.length, 2);
      assert.equal(result.segments[0].text, 'hello & welcome');
      assert.equal(result.segments[0].start, 0.42);
      assert.equal(result.segments[0].duration, 4.2);
    }
  );
});

test('bot-check LOGIN_REQUIRED does not abort the client chain (misread as age restriction)', async () => {
  // Real-world scenario from datacenter IPs: YouTube answers LOGIN_REQUIRED
  // with reason "Sign in to confirm you're not a bot". That is a per-client
  // bot check, NOT an age restriction — the next client identity may pass.
  let playerCalls = 0;

  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        playerCalls += 1;
        if (playerCalls === 1) {
          // First client (Android) gets the bot wall
          return new Response(JSON.stringify({
            playabilityStatus: {
              status: 'LOGIN_REQUIRED',
              reason: "Sign in to confirm you're not a bot",
            },
          }));
        }
        // Next client passes
        return new Response(JSON.stringify({
          playabilityStatus: { status: 'OK' },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [
                {
                  baseUrl: 'https://captions.test/en',
                  languageCode: 'en',
                  name: { simpleText: 'English' },
                },
              ],
            },
          },
        }));
      }

      if (url.startsWith('https://captions.test/en')) {
        return new Response(`<?xml version="1.0"?><transcript>
          <text start="0" dur="2">it worked</text>
        </transcript>`);
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.ok(result, 'bot check on one client must not kill the whole fetch');
      assert.equal(result.segments[0].text, 'it worked');
      assert.ok(playerCalls >= 2, 'should have tried a second client identity');
    }
  );
});

test('genuine age restriction still aborts the client chain', async () => {
  let playerCalls = 0;

  await withMockFetch(
    async (input) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('youtube.com/watch')) {
        return new Response(FAKE_WATCH_PAGE);
      }

      if (url.includes('/youtubei/v1/player')) {
        playerCalls += 1;
        return new Response(JSON.stringify({
          playabilityStatus: {
            status: 'LOGIN_REQUIRED',
            reason: 'Sign in to confirm your age. This video may be inappropriate for some users.',
          },
        }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    },
    async () => {
      const result = await fetchYouTubeTranscript('video123');

      assert.equal(result, null);
      assert.equal(playerCalls, 1, 'age restriction is video-level — no retry with other clients');
    }
  );
});
