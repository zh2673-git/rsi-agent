{"op":"trace.append","session_id","events":[Event]}    → {"ok":true,"count":int}
{"op":"trace.read","session_id","after"?}              → {"ok":true,"events":[Event],"next":int}
{"op":"trace.meta","session_id"}                       → {"ok":true,"exists":bool,"size":int,"mtime_ms":num,"total_events":int,"end_cursor":int}
{"op":"session.skills","session_id"}                   → {"ok":true,"skills":[str],"total_events":int}
{"op":"rollback","session_id","upto_user_index":int}   → {"ok":true,"removed_messages":int,"removed_events":int}
