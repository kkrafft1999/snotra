// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkScreenshots from './src/plugins/remark-screenshots.mjs';
import remarkSinceMarker from './src/plugins/remark-since-marker.mjs';
import chapters from './chapters.json' with { type: 'json' };

export default defineConfig({
  site: 'https://docs.snotra-ai.dev',
  markdown: {
    remarkPlugins: [remarkScreenshots, remarkSinceMarker],
  },
  integrations: [
    starlight({
      title: { en: 'Snotra Agent Manual', de: 'Snotra Agent Handbuch' },
      logo: { src: '../assets/icon/icon-windows.svg' },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        de: { label: 'Deutsch', lang: 'de' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/kkrafft1999/snotra' },
      ],
      editLink: {
        baseUrl: 'https://github.com/kkrafft1999/snotra/edit/main/manual/',
      },
      // One group per chapter of #777; the pages inside are ordered by their
      // `sidebar.order`. Starlight finds the German page at the same path.
      // The list lives in chapters.json, which the in-app manual reads as
      // well (#790), so both show the same chapters in the same order.
      sidebar: [
        {
          slug: chapters.overview.slug,
          label: chapters.overview.label.en,
          translations: { de: chapters.overview.label.de },
        },
        ...chapters.chapters.map(({ directory, label }) => ({
          label: label.en,
          translations: { de: label.de },
          items: [{ autogenerate: { directory } }],
        })),
      ],
      customCss: ['@fontsource/inter/400.css', '@fontsource/inter/600.css', './src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
    }),
  ],
});
