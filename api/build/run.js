const { config, handleApiRoute } = require("../_shared");

module.exports = async (req, res) => handleApiRoute(req, res, "/api/build/run");
module.exports.config = config;
