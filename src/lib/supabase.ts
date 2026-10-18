import { createClient } from "@supabase/supabase-js";

/*
 * Projeto Supabase "spherum" (região São Paulo).
 * A URL e a publishable key são públicas (vão para o navegador de qualquer forma),
 * então ficam aqui como padrão. As variáveis de ambiente, se existirem, têm prioridade.
 * A segurança dos dados vem das políticas de RLS no banco, não do sigilo destas chaves.
 * Nunca coloque aqui a secret key (service_role) nem a senha do banco.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://fszbxwlxuncqefcwttru.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_zAhuSdMR3g2zHAb7WwYyCQ_XW8CLEth";

/** Cliente do Supabase com a publishable key: seguro para o navegador, sujeito às políticas de RLS. */
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
