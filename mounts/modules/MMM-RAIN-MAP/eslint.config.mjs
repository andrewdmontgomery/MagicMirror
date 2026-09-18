// @ts-check
import eslint from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // Build artifacts and generated files
  globalIgnores(['MMM-RAIN-MAP.js', 'node_helper.js', 'config.demo.js', 'changelog.config.js', 'leaflet.css']),

  // TypeScript source files
  {
    files: ['src/**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.strict, tseslint.configs.stylistic],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        sourceType: 'module',
        ecmaVersion: 'latest'
      }
    },
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off'
    }
  },

  // Test files
  {
    files: ['tests/**/*.test.js'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        global: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    }
  }
)
