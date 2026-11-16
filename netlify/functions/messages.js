const { adapt } = require("../shared");

const handler = adapt(require("../../serverless/chat").messages);

exports.handler = (event) => {
  const match = event.path?.match(
    /\/api\/conversations\/([^/]+)\/messages\/?$|\/\.netlify\/functions\/messages\/([^/]+)\/?$/,
  );
  const id = match ? decodeURIComponent(match[1] || match[2]) : event.queryStringParameters?.id;

  return handler({
    ...event,
    queryStringParameters: { ...event.queryStringParameters, id },
  });
};
