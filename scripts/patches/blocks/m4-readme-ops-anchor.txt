{"op":"trace.append","session_id","events":[Event]}    → {"ok":true,"count":int}
{"op":"trace.read","session_id","after"?}              → {"ok":true,"events":[Event],"next":int}
{"op":"rollback","session_id","upto_user_index":int}   → {"ok":true,"removed_messages":int,"removed_events":int}
