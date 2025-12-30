const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function tryArchive(url) {
  try {
    const archiveProbe = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1`;
    const r = await fetchWithTimeout(archiveProbe, { method: 'GET' }, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    if (Array.isArray(j) && j.length > 1 && j[1] && j[1][1]) {
      const timestamp = j[1][1];
      const archivedUrl = `https://web.archive.org/web/${timestamp}/${url}`;
      return archivedUrl;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

// Basic HTML title extraction
function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

// Try to find a plausible publication date in common meta tags or visible date strings
function extractPublishDate(html) {
  // meta tags
  const metaDate = html.match(/<meta[^>]+(property|name)=["']?(article:published_time|pubdate|publication_date|date|article:published)["']?[^>]*content=["']([^"']+)["'][^>]*>/i);
  if (metaDate && metaDate[3]) return metaDate[3];
  // common date patterns (YYYY or YYYY-MM-DD or Month DD, YYYY)
  const datePattern = html.match(/(\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b)|(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\b)/i);
  if (datePattern) return datePattern[0];
  return null;
}

async function verifySource(url, expectedExcerpt = '') {
  const out = { url, ok: false, status: null, finalUrl: null, excerptFound: false, foundDate: null, archivedUrl: null, reason: null, title: null };
  if (!url) { out.reason = 'no-url'; return out; }

  try {
    let r;
    try {
      r = await fetchWithTimeout(url, { method: 'HEAD' }, 5000);
    } catch (e) {
      // HEAD may be blocked; try GET
    }

    if (!r || !r.ok) {
      // try GET
      try {
        r = await fetchWithTimeout(url, { method: 'GET' }, 8000);
      } catch (e) {
        out.reason = 'http-error';
        // try archive
        const archived = await tryArchive(url);
        if (archived) {
          out.archivedUrl = archived;
          out.reason = 'archived';
          out.ok = true;
          out.finalUrl = archived;
          return out;
        }
        return out;
      }
    }

    out.status = r.status;
    out.finalUrl = r.url;

    // only check HTML-like responses
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      out.reason = 'non-html';
      out.ok = false;
      return out;
    }

    const body = await r.text();
    out.title = extractTitle(body);
    out.foundDate = extractPublishDate(body);

    if (expectedExcerpt) {
      out.excerptFound = body.toLowerCase().includes(expectedExcerpt.toLowerCase().slice(0, 120));
    }

    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'exception';
    return out;
  }
}

module.exports = { verifySource };
