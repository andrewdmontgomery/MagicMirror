import neostandard from 'neostandard'
import globals from 'globals'

export default [
  ...neostandard(),
  {
    // Third-party and generated files are exempt from linting.
    ignores: [
      'mounts/modules/**/vendor/**',
      'mounts/modules/**/tests/fixtures/**',
      'mounts/config/basepath.js'
    ]
  },
  {
    // MagicMirror front-end modules run in the browser with MM globals.
    files: ['mounts/modules/*/MMM-*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Module: 'readonly',
        Log: 'readonly'
      }
    }
  }
]
