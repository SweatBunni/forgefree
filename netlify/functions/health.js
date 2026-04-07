const { runRoute } = require("./_shared");

exports.handler = async (event) => runRoute(event, "/api/health");
