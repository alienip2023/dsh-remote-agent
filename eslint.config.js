/**
 * ESLint 配置 —— 「严格档」的边界划在这里。
 *
 * 选型原则：本包零运行时依赖、无构建步骤，`lib/**` 即产物。所以：
 *   - 只做**静态正确性与一致性**检查（推荐集 + 一批高信号的一致性规则），
 *     不引入需要 type-aware 的规则（那要装 TS 编译器，违背零依赖哲学）。
 *   - 不改语义的规则优先，容易引发行为漂移的规则（如 prefer-template、
 *     object-shorthand）不启用 —— 对一个已有 600+ 测试钉住行为的包，
 *     改写表达式形式的风险大于收益。
 *   - test/** 放宽两处：测试里的宽松断言风格是刻意的（黄金向量可读性）。
 *
 * 运行：npm run lint（CI 里有独立 lint job，见 .github/workflows/ci.yml）。
 */
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['lib/**/*.js', 'bin/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // 注释里的零宽空格是刻意的：docblock 里要写 ``*/`` 的转义形态（实测
      // test/bounded-resources.test.js:29），按普通空白误报没有价值。
      'no-irregular-whitespace': ['error', { skipComments: true }],
      // ── 推荐集之内的收紧 ──
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all' }],
      'no-implicit-globals': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eq-null': 'off', // eqeqeq null:'ignore' 已覆盖
      'no-else-return': ['error', { allowElseIf: true }],
      'no-fallthrough': 'error',
      'no-async-promise-executor': 'error',
      'no-loop-func': 'error',
      'no-loss-of-precision': 'error',
      'no-template-curly-in-string': 'error',
      'no-return-assign': ['error', 'always'],
      'no-throw-literal': 'error',
      'no-useless-catch': 'error',
      'no-useless-concat': 'error',
      'require-atomic-updates': 'error',
      'default-param-last': 'error',
      'grouped-accessor-pairs': ['error', 'getBeforeSet'],
      'no-shadow': ['error', { builtinGlobals: false, allow: ['_'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'SequenceExpression',
          message: '禁用逗号序列表达式（读性差、易漏副作用）',
        },
      ],
    },
  },
  {
    // lib/client.js 是浏览器端 web 包（`import 'dsh-remote-agent/client'`），
    // 直接操作 window/document —— 浏览器 globals 与 Node globals 并存。
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // 测试放宽：node:test 的上下文参数约定叫 `t`，大量用例用不到它 ——
      // 这是框架惯例不是坏味道，按 `_` 同等对待。
      'no-unused-vars': ['error', { argsIgnorePattern: '^(_|t)$', varsIgnorePattern: '^_' }],
      // 同 lib：注释里的零宽空格是 docblock 转义手法
      'no-irregular-whitespace': ['error', { skipComments: true }],
      'no-shadow': 'off',
      'no-else-return': 'off',
    },
  },
]
