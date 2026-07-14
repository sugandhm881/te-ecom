/** @type {import('tailwindcss').Config} */
// Static Tailwind build — replaces the runtime cdn.tailwindcss.com (a browser JIT compiler that
// recompiled CSS on every DOM change and taxed every render). Rebuild after changing classes:
//   npx tailwindcss -i ./tw-input.css -o ./app/static/tailwind.css --minify
module.exports = {
  content: [
    './app/templates/**/*.html',
    './app/static/**/*.js',
  ],
  // No safelist needed — a class-scan confirmed the app uses only literal Tailwind classes (which the
  // content scan catches). If a view ever loses a color, add just that exact class here and rebuild.
  theme: { extend: {} },
  plugins: [],
};
