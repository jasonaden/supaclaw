-- Drop old 1536-dimension function overloads (replaced by 768-dim versions in gemini migration)
DROP FUNCTION IF EXISTS public.match_memories(vector, double precision, integer, text, text, text, double precision);
DROP FUNCTION IF EXISTS public.hybrid_search_memories(text, vector, double precision, double precision, integer, text);
