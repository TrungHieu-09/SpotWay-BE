import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  { files: ['src/**/*.ts', 'test/**/*.ts'], languageOptions: { parser: tseslint.parser } },
);
