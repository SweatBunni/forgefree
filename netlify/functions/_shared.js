const { createNetlifyResponse, processApiRequest } = require("../../backend");

function decodeEventBody(event) {
  if (!event?.body) {
    return "";
  }

  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
}

async function runRoute(event, pathname) {
  const apiResponse = await processApiRequest({
    method: event?.httpMethod || "GET",
    pathname,
    bodyText: decodeEventBody(event),
  });
  return createNetlifyResponse(apiResponse);
}

module.exports = {
  runRoute,
};
