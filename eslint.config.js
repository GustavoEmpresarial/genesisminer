// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Regra pedida explicitamente: nada de número solto sem constante nomeada.
      // ignoreArrayIndexes/ignoreDefaultValues cobrem os falsos-positivos mais comuns
      // (arr[0], `= 0` default) sem abrir mão do resto.
      'no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreClassFieldInitialValues: true,
          enforceConst: true,
          detectObjects: false
        }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off'
    }
  },
  {
    // tests/ espelha server/ (ver docs/development/backend — nunca *.test.ts dentro
    // de server/, sempre em tests/<mesmo-caminho>).
    files: ['tests/**/*.test.ts'],
    rules: {
      // Testes têm número mágico o tempo todo por natureza (timestamps, tamanhos de payload
      // de teste) — barulho sem valor real de revisão.
      'no-magic-numbers': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  }
);
