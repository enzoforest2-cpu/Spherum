import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Spherum",
  description: "O sistema operacional para gestores de tráfego e agências de performance.",
};

/**
 * O front do Spherum é servido direto dos arquivos exportados do Claude Design
 * (public/site e public/prototipo), sem alterações. Veja as rotas em next.config.ts.
 * Este layout só existe para as rotas do Next.js que forem criadas (ex.: API do backend).
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
