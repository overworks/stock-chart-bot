create function public.chart_test_set_image_time(p_name text, p_created_at timestamptz)
returns void language sql security definer set search_path = '' as $$
  update storage.objects set created_at = p_created_at where bucket_id = 'charts' and name = p_name;
$$;
revoke all on function public.chart_test_set_image_time(text, timestamptz) from public, anon, authenticated;
grant execute on function public.chart_test_set_image_time(text, timestamptz) to service_role;
