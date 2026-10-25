# Admin UI conventions

Admin uses one Ant Design theme, defined in `frontend/src/theme.ts`, and shared application styles in `frontend/src/console.css`. Keep the green identity and use hierarchy and semantic colors to distinguish actions and states.

| Element | Convention |
| --- | --- |
| Standard buttons, text/password/number inputs and selects | 36px high, 14px text, 8px radius |
| Compact toolbar and icon actions | 32px high, 12px text, 6px radius |
| Large controls, when explicitly needed | 40px high, 16px text |
| Status tags | 24px minimum height, 12px text, 6px radius; retain text and allow wrapping when needed |
| Navigation targets | 44px minimum height for comfortable interaction |
| Spacing | 4, 8, 12, 16, 24 and 32px |
| Typography | Page titles 20px, panel titles 16px, body 14px, supporting text 12px |
| Containers | White surfaces on a cool neutral background, 12px radius, subtle border/shadow |
| Metrics | Numeric values use 28px emphasis; descriptive values scale from 16–24px to fit their card |

Primary buttons identify the page's main action. Ordinary actions use bordered buttons; secondary inline actions use text buttons. Destructive actions remain red and retain confirmation. Loading and disabled states preserve the same dimensions. Controls in one row use the same size; compact chat selectors must align with their adjacent standard buttons.

Use the shared `Status` component for execution/readiness tags. Success is green, active work blue, attention/unknown amber, failure red, and inactive states neutral. Keep the status text: color and dots supplement it. Do not invent page-specific tag colors or sizes.

The global theme owns control sizing, borders, focus rings, disabled colors, dropdowns and modal surfaces. Local CSS may handle layout, not redefine component density. Scope compact toolbar styling explicitly; do not shrink table controls or tags merely because the viewport is narrow. Multiline textareas and long labels may grow as needed.

Maintain visible keyboard focus, readable text contrast, and reduced-motion support. Preserve responsive list fields, usable dialog/composer scrolling, and actions in Chinese and English at desktop, tablet and phone widths.
