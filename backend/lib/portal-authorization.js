'use strict';

function authorizationUrlFromDirectory(directoryUrl, portalUserId) {
  if (!directoryUrl) throw new Error('Portal directory URL is not configured');
  const url = new URL(directoryUrl);
  const before = url.pathname;
  url.pathname = before.replace(/\/directory\/?$/, `/authorization/${encodeURIComponent(String(portalUserId))}`);
  if (url.pathname === before) {
    throw new Error('Portal directory URL must end with /directory');
  }
  return url.toString();
}

async function fetchPortalAuthorization({
  directoryUrl,
  apiKey,
  portalUserId,
  fetchImpl = fetch,
  timeoutMs = 5000,
}) {
  if (!apiKey || apiKey.length < 32) {
    const err = new Error('Portal authorization validation is not configured');
    err.statusCode = 503;
    throw err;
  }
  const url = authorizationUrlFromDirectory(directoryUrl, portalUserId);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'x-internal-api-key': apiKey,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const err = new Error('Unable to validate current TimeClock authorization with Employee Portal');
    err.statusCode = 503;
    err.cause = cause;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Employee Portal authorization validation returned HTTP ${response.status}`);
    err.statusCode = 503;
    throw err;
  }
  const body = await response.json();
  if (!body || String(body.portal_user_id || '') !== String(portalUserId)) {
    const err = new Error('Employee Portal returned an invalid authorization record');
    err.statusCode = 503;
    throw err;
  }
  return body;
}

module.exports = {
  authorizationUrlFromDirectory,
  fetchPortalAuthorization,
};
