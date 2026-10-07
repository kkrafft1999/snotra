// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkScreenshots from './src/plugins/remark-screenshots.mjs';
import remarkSinceMarker from './src/plugins/remark-since-marker.mjs';

export default defineConfig({
  site: 'https://docs.snotra-ai.dev',
  markdown: {
    remarkPlugins: [remarkScreenshots, remarkSinceMarker],
  },
  integrations: [
    starlight({
      title: { en: 'Snotra AI Manual', de: 'Snotra AI Handbuch' },
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
      customCss: ['@fontsource/inter/400.css', '@fontsource/inter/600.css', './src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
    }),
  ],
});
