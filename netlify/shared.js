function adapt(handler) {
  return async (event) => {
    let statusCode = 200;
    let body = "";
    const headers = {};
    const request = {
      method: event.httpMethod,
      body: event.body,
      query: event.queryStringParameters || {},
    };
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(value);
        return this;
      },
      setHeader(name, value) {
        headers[name] = value;
      },
    };

    await handler(request, response);
    return { statusCode, headers, body };
  };
}

module.exports = { adapt };
