# Rookie Works — sitio del estudio

Sitio web público de **Rookie Works**, estudio de software independiente. Estático puro (HTML + CSS + JS vanilla), servido en **GitHub Pages**.

**En vivo:** https://rookieworks.github.io

## Para qué sirve este sitio

1. Sitio del desarrollador declarado en Google Play Console.
2. Aloja `app-ads.txt` para verificar la autoría de anuncios en AdMob.
3. Aloja la política de privacidad (obligatoria para publicar en Play).
4. Cara pública del estudio (landing).

## Estructura

| Archivo | Qué es |
|---------|--------|
| `index.html` | Landing (bilingüe ES/EN, tema claro/oscuro). Todo el CSS y JS va embebido. |
| `privacy.html` / `privacy-en.html` | Política de privacidad ES / EN. |
| `app-ads.txt` | Autorización de anuncios para AdMob. |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png` | Iconos. |
| `og.png` | Imagen para compartir en redes (Open Graph, 1200×630). |
| `robots.txt`, `sitemap.xml`, `site.webmanifest` | SEO / PWA básica. |

## URLs para Google Play Console

- Política de privacidad (ES): `https://rookieworks.github.io/privacy.html`
- Política de privacidad (EN): `https://rookieworks.github.io/privacy-en.html`
- Sitio del desarrollador: `https://rookieworks.github.io`

## Pendientes por rellenar (placeholders)

- **Email de contacto:** buscar `rookieworksdev@gmail.com` en `index.html`, `privacy.html` y `privacy-en.html` y reemplazarlo por el correo real.
- **Publisher ID de AdMob:** en `app-ads.txt`, cambiar `pub-XXXXXXXXXXXXXXXX` (se saca de AdMob → Configuración → Información de la cuenta).
- **Package name:** las políticas usan `com.rookieworks.sudokubloom` como placeholder.
- **Redes sociales:** los enlaces de X/GitHub/LinkedIn en `index.html` apuntan a `#`.

## Cómo editar y publicar

No hay build ni dependencias. Editas el HTML y publicas con git:

```bash
git add -A
git commit -m "descripción del cambio"
git push
```

GitHub Pages reconstruye solo en ~1–2 minutos. Para previsualizar en local, basta abrir `index.html` en el navegador.

## Notas técnicas

- **Tipografías:** Fraunces (títulos), JetBrains Mono (etiquetas), Inter (texto) — vía Google Fonts.
- **Identidad:** monocromo cálido + acento ámbar (`#E8833A` oscuro / `#CF6F22` claro). Tema automático (respeta el sistema) con toggle manual guardado en `localStorage`.
- **i18n:** el idioma se cambia por JS con un diccionario; el español es el contenido base en el HTML.
- **Agregar un proyecto nuevo:** en `index.html`, sección `#proyectos`, duplicar un bloque `<article class="card">` (el grid es `auto-fill`).
