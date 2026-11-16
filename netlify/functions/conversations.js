const { adapt } = require("../shared");

exports.handler = adapt(require("../../serverless/chat").conversations);
