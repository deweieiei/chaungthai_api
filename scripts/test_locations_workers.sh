#!/bin/bash
# ============================================================
#  Test locations + workers endpoints
# ============================================================

set -u
BASE="http://localhost:3000"
CT="Content-Type: application/json"

hr() { echo; echo "============================================================"; echo "  $1"; echo "============================================================"; }

hr "1. GET /api/locations/provinces (sample)"
curl -s "$BASE/api/locations/provinces" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("total:", d["total"])
print("first 3:", [p["province_name_th"] for p in d["provinces"][:3]])
print("Bangkok (id=1):", [p for p in d["provinces"] if p["province_id"]==1][0])
'

hr "2. GET /api/locations/districts?province_id=1 (Bangkok)"
curl -s "$BASE/api/locations/districts?province_id=1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("total:", d["total"])
print("first 3:", [x["district_name_th"] for x in d["districts"][:3]])
'

hr "3. GET /api/locations/subdistricts?district_id=1001 (เขตพระนคร)"
curl -s "$BASE/api/locations/subdistricts?district_id=1001" | python3 -m json.tool | head -30

hr "4. Login user_id=4 -> get token"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d '{"user_email":"test1@example.com","user_password":"testpass1234"}')
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "token: ${TOKEN:0:40}..."

hr "5. PUT /api/users/4 - set location (valid parent chain)"
curl -s -X PUT "$BASE/api/users/4" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"user_province_id":1,"user_district_id":1001,"user_subdistrict_id":100101,"user_address":"123/45 ม.6"}' \
  | python3 -m json.tool | head -30

hr "6. PUT /api/users/4 - invalid parent chain (should 400)"
curl -s -X PUT "$BASE/api/users/4" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"user_province_id":1,"user_district_id":5001}'

hr "7. PUT /api/users/4 - non-existent location (should 400)"
curl -s -X PUT "$BASE/api/users/4" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"user_province_id":999}'

hr "8. POST /api/workers (register as worker)"
WORKER_RES=$(curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"worker_resume":"ช่างไฟฟ้า 10 ปี รับงานทั่วกรุงเทพ"}')
echo "$WORKER_RES" | python3 -m json.tool
WORKER_ID=$(echo "$WORKER_RES" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("worker_id",""))')
echo "worker_id captured: $WORKER_ID"

hr "9. POST /api/workers again (should 409 duplicate)"
curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"worker_resume":"another"}'

hr "10. PUT /api/workers/$WORKER_ID/skills - select skill 1, 11, 13"
curl -s -X PUT "$BASE/api/workers/$WORKER_ID/skills" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"skill_ids":[1,11,13]}'

echo
hr "11. PUT /skills - bad skill id (should 400 with missing_skill_ids)"
curl -s -X PUT "$BASE/api/workers/$WORKER_ID/skills" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"skill_ids":[1,99999]}'

echo
hr "12. GET /api/workers/search skill=13 subdistrict=100101 (should find worker)"
curl -s "$BASE/api/workers/search?skill_id=13&subdistrict_id=100101" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("matched_level:", d["matched_level"])
print("total:", d["total"])
if d["workers"]:
    w = d["workers"][0]
    print("  worker_id:", w["worker_id"])
    print("  name:", w["user_name"], w.get("user_lastname"))
    print("  skill:", w["skill_name_th"])
    print("  area:", w["subdistrict_name_th"], "/", w["district_name_th"], "/", w["province_name_th"])
'

hr "13. GET search - different subdistrict (should 0)"
curl -s "$BASE/api/workers/search?skill_id=13&subdistrict_id=100102" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("matched_level:", d["matched_level"])
print("total:", d["total"])
'

hr "14. GET search with auto_expand - subdistrict miss but district hit"
curl -s "$BASE/api/workers/search?skill_id=13&subdistrict_id=100102&district_id=1001&auto_expand=true" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("matched_level:", d["matched_level"])
print("total:", d["total"])
'

hr "15. GET search no location (should 400)"
curl -s "$BASE/api/workers/search?skill_id=13"

echo
hr "DONE"
