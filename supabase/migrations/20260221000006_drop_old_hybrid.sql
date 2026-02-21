-- Drop old hybrid_search overload with extra params
DROP FUNCTION IF EXISTS public.hybrid_search_memories(vector, text, double precision, double precision, integer, text, text, text, double precision);
