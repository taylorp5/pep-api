const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// No debug logs in production: strip all console.* when minifying (production builds)
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  config.transformer = config.transformer || {};
  config.transformer.minifierConfig = {
    ...(config.transformer.minifierConfig || {}),
    compress: {
      ...(config.transformer.minifierConfig?.compress || {}),
      drop_console: true,
    },
  };
}

module.exports = config;
