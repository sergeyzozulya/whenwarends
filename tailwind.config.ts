import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        accent: '#2c5aa0', // muted blue
      },
      typography: (theme) => ({
        DEFAULT: {
          css: {
            '--tw-prose-body': theme('colors.gray.900'),
            '--tw-prose-headings': theme('colors.gray.900'),
            '--tw-prose-links': theme('colors.accent'),
            '--tw-prose-code': theme('colors.gray.700'),
            '--tw-prose-invert-body': theme('colors.gray.100'),
            '--tw-prose-invert-headings': theme('colors.gray.100'),
            '--tw-prose-invert-links': theme('colors.accent'),
          },
        },
      }),
      fontSize: {
        xs: '13px',
        sm: '16px',
        base: '16px',
        lg: '22px',
      },
      fontWeight: {
        normal: '400',
        medium: '500',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
} satisfies Config;
