#!/bin/bash
# ============================================================
#  Test all endpoints (users + skills)
#  Usage: bash /tmp/test_endpoints.sh
# ============================================================

set -u  # error on undefined variable

BASE="http://localhost:3000"
CT="Content-Type: application/json"

echo "============================================================"
echo "  Test 1: GET /api/users/4 (public profile)"
echo "============================================================"
curl -s "$BASE/api/users/4" | python3 -m json.tool

echo
echo "============================================================"
echo "  Test 2: GET /api/users/9999 (should 404)"
echo "============================================================"
curl -s "$BASE/api/users/9999"

echo
echo
echo "============================================================"
echo "  Test 3: PUT without token (should 401)"
echo "============================================================"
curl -s -X PUT "$BASE/api/users/4" -H "$CT" -d '{"user_bio":"x"}'

echo
echo
echo "============================================================"
echo "  Test 4: Login user_id=4 -> get token"
echo "============================================================"
LOGIN_RES=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d '{"user_email":"test1@example.com","user_password":"testpass1234"}')
echo "login response: $LOGIN_RES" | head -c 200
echo
TOKEN=$(echo "$LOGIN_RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "token (first 40 chars): ${TOKEN:0:40}..."

echo
echo "============================================================"
echo "  Test 5: PUT /api/users/4 with token - partial update + ignored field"
echo "============================================================"
curl -s -X PUT "$BASE/api/users/4" \
  -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_bio":"ทดสอบ bio ภาษาไทย","user_phone":"0812345678","user_email":"hack@test.com","user_role":"admin"}' \
  | python3 -m json.tool

echo
echo "============================================================"
echo "  Test 6: PUT other user (should 403)"
echo "============================================================"
curl -s -X PUT "$BASE/api/users/5" \
  -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_bio":"hack"}'

echo
echo
echo "============================================================"
echo "  Test 7: PUT without any updatable field (should 400)"
echo "============================================================"
curl -s -X PUT "$BASE/api/users/4" \
  -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_email":"hack@test.com","user_role":"admin","user_password":"hack"}'

echo
echo
echo "============================================================"
echo "  Test 8: GET /api/skills - check totals + sample"
echo "============================================================"
curl -s "$BASE/api/skills" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("total_categories:", d["total_categories"])
print("total_subcategories:", d["total_subcategories"])
print("total_skills:", d["total_skills"])
print()
print("=== First category ===")
c = d["categories"][0]
print("  skill_category_id:", c["skill_category_id"])
print("  name_th:", c["skill_category_name_th"])
print("  name_en:", c["skill_category_name_en"])
print("  subcategories:", len(c["subcategories"]))
print()
print("  === First subcategory ===")
sub = c["subcategories"][0]
print("    skill_subcategory_id:", sub["skill_subcategory_id"])
print("    name_th:", sub["skill_subcategory_name_th"])
print("    skills count:", len(sub["skills"]))
print()
print("    === First skill ===")
s = sub["skills"][0]
print("      skill_id:", s["skill_id"])
print("      name_th:", s["skill_name_th"])
print("      name_en:", s["skill_name_en"])
'

echo
echo "============================================================"
echo "  DONE"
echo "============================================================"
