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
      sidebar: [
        { slug: 'index', label: 'Overview', translations: { de: 'Überblick' } },
        {
          label: 'Getting started',
          translations: { de: 'Erste Schritte' },
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Chatting',
          translations: { de: 'Chatten' },
          items: [{ autogenerate: { directory: 'chatting' } }],
        },
        {
          label: 'The workspace',
          translations: { de: 'Der Arbeitsbereich' },
          items: [{ autogenerate: { directory: 'workspace' } }],
        },
        {
          label: 'Modes, permissions and safety',
          translations: { de: 'Modi, Freigaben und Sicherheit' },
          items: [{ autogenerate: { directory: 'safety' } }],
        },
        {
          label: 'Customising',
          translations: { de: 'Anpassen' },
          items: [{ autogenerate: { directory: 'customising' } }],
        },
        {
          label: 'Updating',
          translations: { de: 'Aktualisieren' },
          items: [{ autogenerate: { directory: 'updating' } }],
        },
        {
          label: 'Troubleshooting',
          translations: { de: 'Hilfe bei Problemen' },
          items: [{ autogenerate: { directory: 'troubleshooting' } }],
        },
        {
          label: 'Reference',
          translations: { de: 'Referenz' },
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
      customCss: ['@fontsource/inter/400.css', '@fontsource/inter/600.css', './src/styles/theme.css'],
      components: {
        SiteTitle: './src/components/SiteTitle.astro',
      },
    }),
  ],
});
