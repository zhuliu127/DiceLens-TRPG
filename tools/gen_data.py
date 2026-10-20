# -*- coding: utf-8 -*-
"""
从 Excel 提取的结构化 JSON 生成前端数据模块 (web/js/data/*.js)
数据源: D:/AI/跑团车卡app/_dump/*.json
"""
import json, os, io

SRC = "D:/AI/跑团车卡app/_dump"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "js", "data")
OUT = os.path.normpath(OUT)
os.makedirs(OUT, exist_ok=True)


def load(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return json.load(f)


def js(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def unesc(s):
    """把导出时转义的换行还原为真实换行"""
    if not isinstance(s, str):
        return s
    return s.replace("\\n", "\n").strip()


def write_module(filename, varname, obj, header=""):
    path = os.path.join(OUT, filename)
    with open(path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成，请勿手改。源: 空白自动卡 - 副本.xlsx */\n")
        if header:
            f.write("/* %s */\n" % header)
        f.write("window.%s = %s;\n" % (varname, js(obj)))
    print("%-28s %8d bytes" % (filename, os.path.getsize(path)))


# ============================================================
# 1. 技能表  (COC 7th 标准技能, 基础值取自人物卡; 子类取自"分支技能与资产")
# ============================================================
# 分类: 战斗 / 探索 / 交流 / 知识 / 生存 / 其他 / 自定义
SKILL_DEFS = [
    # (id, name, category, base, subOf)
    ("accounting",        "会计",         "知识", 5),
    ("anthropology",      "人类学",       "知识", 1),
    ("appraise",          "估价",         "知识", 5),
    ("archaeology",       "考古学",       "知识", 1),
    ("art_craft",         "技艺",         "知识", 5, None),   # 艺术与手艺, 带子类
    ("charm",             "魅惑",         "交流", 15),
    ("climb",             "攀爬",         "生存", 20),
    ("computer",          "计算机使用",   "知识", 5),
    ("credit",            "信用评级",     "其他", 0),
    ("cthulhu",           "克苏鲁神话",   "知识", 0),
    ("disguise",          "乔装",         "交流", 5),
    ("dodge",             "闪避",         "战斗", 20),
    ("drive_auto",        "汽车驾驶",     "其他", 20),
    ("elec_repair",       "电气维修",     "其他", 10),
    ("electronics",       "电子学",       "知识", 1),
    ("fast_talk",         "话术",         "交流", 5),
    ("fighting",          "格斗",         "战斗", 25, None),   # 带子类
    ("firearms",          "射击",         "战斗", 20, None),   # 带子类
    ("first_aid",         "急救",         "生存", 30),
    ("history",           "历史",         "知识", 5),
    ("intimidate",        "恐吓",         "交流", 15),
    ("jump",              "跳跃",         "生存", 20),
    ("language_other",    "外语",         "知识", 1),
    ("language_own",      "母语",         "知识", 0),          # 初始 = EDU
    ("law",               "法律",         "知识", 5),
    ("library",           "图书馆使用",   "知识", 20),
    ("listen",            "聆听",         "探索", 20),
    ("locksmith",         "锁匠",         "探索", 1),
    ("mech_repair",       "机械维修",     "其他", 10),
    ("medicine",          "医学",         "知识", 1),
    ("natural_world",     "博物学",       "知识", 10),
    ("navigate",          "领航",         "探索", 10),
    ("occult",            "神秘学",       "知识", 5),
    ("op_heavy",          "操作重型机械", "其他", 1),
    ("persuade",          "说服",         "交流", 10),
    ("pilot",             "驾驶",         "其他", 1, None),    # 带子类: 飞行器/船
    ("psychoanalysis",    "精神分析",     "知识", 1),
    ("psychology",        "心理学",       "交流", 10),
    ("ride",              "骑术",         "其他", 5),
    ("science",           "科学",         "知识", 1, None),    # 带子类
    ("sleight",           "妙手",         "探索", 10),
    ("spot_hidden",       "侦查",         "探索", 25),
    ("stealth",           "潜行",         "探索", 20),
    ("survival",          "生存",         "生存", 10, None),
    ("swim",              "游泳",         "生存", 20),
    ("throw",             "投掷",         "战斗", 20),
    ("track",             "追踪",         "探索", 10),
    ("animal_handling",   "驯兽",         "生存", 5),
    ("diving",            "潜水",         "生存", 1),
    ("demolitions",       "爆破",         "战斗", 1),
    ("lip_reading",       "读唇",         "探索", 1),
    ("hypnosis",          "催眠",         "知识", 1),
    ("artillery",         "炮术",         "战斗", 1),
    ("lore",              "学问",         "自定义", 0),
]

# 子类技能表 (来自"分支技能与资产")
SUBSKILLS = {
    "art_craft": [
        ("表演", 5), ("美术", 5), ("摄影", 5), ("伪造", 5), ("文学", 5), ("书法", 5),
        ("乐理", 5), ("厨艺", 5), ("裁缝", 5), ("理发", 5), ("建筑", 5), ("舞蹈", 5),
        ("酿酒", 5), ("捕鱼", 5), ("歌唱", 5), ("制陶", 5), ("雕塑", 5), ("杂技", 5),
        ("风水", 5), ("技术制图", 5), ("耕作", 5), ("打字", 5), ("速记", 5), ("木匠", 5),
        ("莫里斯舞", 5), ("歌剧歌唱", 5), ("粉刷匠与油漆工", 5), ("吹制玻璃管", 5),
    ],
    "science": [
        ("地质学", 1), ("化学", 1), ("生物学", 1), ("数学", 1), ("天文学", 1),
        ("物理学", 1), ("药学", 1), ("植物学", 1), ("动物学", 1), ("密码学", 1),
        ("工程学", 1), ("气象学", 1), ("司法科学", 1),
    ],
    "fighting": [
        ("鞭子", 5), ("电锯", 10), ("斗殴", 25), ("斧", 15), ("剑", 20),
        ("绞具", 15), ("链枷", 10), ("矛", 20),
    ],
    "firearms": [
        ("步枪/霰弹枪", 25), ("冲锋枪", 15), ("弓", 15), ("喷射器", 10),
        ("机枪", 10), ("手枪", 20), ("重武器", 10),
    ],
    "pilot": [("飞行器", 1), ("船", 1)],
}

skills = []
for d in SKILL_DEFS:
    sid, name, cat, base = d[0], d[1], d[2], d[3]
    subs = [{"name": n, "base": b} for n, b in SUBSKILLS.get(sid, [])]
    skills.append({
        "id": sid, "name": name, "category": cat, "base": base,
        "special": bool(subs), "subskills": subs,
        "eras": ["any"],
        "desc": "",
    })

write_module("skills.js", "COC_SKILLS", skills,
             "标准技能表 %d 项" % len(skills))

# ============================================================
# 2. 职业表
# ============================================================
raw_occ = load("occupations.json")
occupations = []
for o in raw_occ:
    no = o["no"]
    if no == "0":
        continue
    credit = o["credit"].replace("～", "-").replace("—", "-").strip()
    cmin, cmax = None, None
    if credit and "-" in credit:
        parts = credit.split("-")
        try:
            cmin = int(parts[0].strip())
            cmax = int(parts[1].strip())
        except Exception:
            cmin = cmax = None
    occupations.append({
        "id": "occ%s" % no,
        "no": int(no),
        "name": o["name"],
        "creditText": credit,
        "creditMin": cmin,
        "creditMax": cmax,
        "attrFormula": o["attr"],          # 属性点公式原文, 如 "教育×2＋敏捷×2"
        "pointsSample": o["pts"],          # 样例点数(仅供参考)
        "skillText": unesc(o["skills"]),   # 本职技能原文
        "contacts": unesc(o["contacts"]),
        "desc": unesc(o["desc"]),
    })
write_module("occupations.js", "COC_OCCUPATIONS", occupations,
             "职业表 %d 项" % len(occupations))

# ============================================================
# 3. 武器表
# ============================================================
# 注意：Excel 武器表下方紧跟「受伤程度 / 护甲调整 / 掩体规则」等说明文字，
# 这些行没有 damage 字段，若不剔除会被当成武器，在武器库里出现
# 「血肉横飞：这个人没救了，真的」这种可选条目。
raw_w = load("weapons.json")
weapons = []
for i, w in enumerate(raw_w):
    if not w["damage"] or len(w["name"] or "") > 34:
        continue
    weapons.append({
        "id": "w%d" % (len(weapons) + 1),
        "name": w["name"],
        "skill": w["skill"],
        "damage": w["damage"],
        "range": w["range"],
        "pierce": w["pierce"],
        "perRound": w["perRound"],
        "ammo": w["ammo"],
        "malfunction": w["malfunction"],
        "era": w["era"],
        "price": w["price"],
        "category": w["category"],
        "note": unesc(w["note"]),
    })
write_module("weapons.js", "COC_WEAPONS", weapons,
             "武器表 %d 项" % len(weapons))

# ============================================================
# 4. 防具表
# ============================================================
# 同样要剔除表尾的「术语解释」段落（防护等级/躯干/网状…），它们没有 armor 值
raw_a = load("armors.json")
armors = []
for i, a in enumerate(raw_a):
    nm = a["name"]
    if not nm or not a["armor"] or len(nm) > 34:
        continue
    armors.append({
        "id": "a%d" % (len(armors) + 1),
        "name": nm,
        "armor": a["armor"],
        "movPenalty": a["movPenalty"],
        "cover": a["cover"],
        "species": a["species"],
        "vsPierce": a["vsPierce"],
        "protectLevel": a["protectLevel"],
        "era": a["era"],
        "price": a["price"],
        "category": a["category"],
        "note": unesc(a["note"]),
    })
write_module("armors.js", "COC_ARMORS", armors,
             "防具/护甲表 %d 项" % len(armors))

# ============================================================
# 5. 载具表
# ============================================================
# 表尾的「术语解释 / 追逐轮可选规则 / 交通事故」段落没有 build 值，需剔除
raw_v = load("vehicles.json")
vehicles = []
for i, v in enumerate(raw_v):
    if not v["name"] or not v["build"] or len(v["name"]) > 34:
        continue
    vehicles.append({
        "id": "v%d" % (len(vehicles) + 1),
        "name": v["name"], "skill": v["skill"], "mov": v["mov"],
        "build": v["build"], "capacity": v["capacity"],
        "armor": v["armor"], "note": unesc(v["note"]),
    })
write_module("vehicles.js", "COC_VEHICLES", vehicles,
             "载具表 %d 项" % len(vehicles))

# ============================================================
# 6. 疯狂附表: 恐惧症 / 狂躁症
# ============================================================
phobias = load("phobias.json")
manias = load("manias.json")


def split_trans(t):
    """把 '洗澡恐惧症（Ablutophobia）：对于洗涤或洗澡的恐惧。' 拆成 名称/英文/描述"""
    import re
    m = re.match(r"^([^（(]+)[（(]([^）)]*)[）)]\s*[:：]\s*(.*)$", t)
    if m:
        return m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
    m2 = re.match(r"^([^:：]+)[:：]\s*(.*)$", t)
    if m2:
        return m2.group(1).strip(), "", m2.group(2).strip()
    return t, "", ""


ph_list = []
for p in phobias:
    nm, en, ds = split_trans(p["text"])
    ph_list.append({"no": p["no"], "name": nm, "en": en, "desc": ds})

ma_list = []
for p in manias:
    nm, en, ds = split_trans(p["text"])
    ma_list.append({"no": p["no"], "name": nm, "en": en, "desc": ds})

write_module("madness.js", "COC_MADNESS", {
    "phobias": ph_list,
    "manias": ma_list,
    "instantSymptoms": [
        {"no": 1, "name": "失忆", "desc": "调查员会发现自己只记得最后身处的安全地点，却没有任何来到这里的记忆。这将会持续 1D10 轮。"},
        {"no": 2, "name": "假性残疾", "desc": "调查员陷入了心理性的失明、失聪以及躯体缺失感中，持续 1D10 轮。"},
        {"no": 3, "name": "暴力倾向", "desc": "调查员陷入了六亲不认的暴力行为中，对周围的敌人与友方进行着无差别的攻击，持续 1D10 轮。"},
        {"no": 4, "name": "偏执", "desc": "调查员陷入了严重的偏执妄想之中，持续 1D10 轮。有人在暗中窥视着他们，同伴中有人背叛了他们，没有人可以信任。"},
        {"no": 5, "name": "人际依赖", "desc": "调查员因为一些原因而将他人误认为了他重要的人并且努力地会与那个人保持那种关系，持续 1D10 轮。"},
        {"no": 6, "name": "昏厥", "desc": "调查员当场昏倒，并需要 1D10 轮才能苏醒。"},
        {"no": 7, "name": "逃避行为", "desc": "调查员会用任何的手段试图逃离现在所处的位置，会试图逃离 1D10 轮。"},
        {"no": 8, "name": "竭嘶底里", "desc": "调查员表现出大笑，哭泣，嘶吼，害怕等的极端情绪表现，持续 1D10 轮。"},
        {"no": 9, "name": "恐惧", "desc": "调查员通过一次 D100 或者由守秘人选择，来从恐惧症状表中选择一个恐惧源，症状会持续 1D10 轮。"},
        {"no": 10, "name": "躁狂", "desc": "调查员通过一次 D100 或者由守秘人选择，来从躁狂症状表中选择一个躁狂的诱因，持续 1D10 轮。"},
    ],
}, "恐惧症 %d 条 / 狂躁症 %d 条" % (len(ph_list), len(ma_list)))

# ============================================================
# 7. 资产参考表 (生活水平)
# ============================================================
LIVING = [
    {"level": "身无分文", "crMin": 0, "crMax": 0,
     "desc": "连贫穷都够不上的人才能够叫做身无分文。住所：大概只有睡大街。旅行：步行，扒车或逃票上火车轮船。"},
    {"level": "拮据", "crMin": 1, "crMax": 9,
     "desc": "刚好买得起最廉价的屋顶，每天能够吃到一餐廉价食物。住所：最廉价的出租屋或睡袋旅馆。旅行：最便宜的公众运输方式。"},
    {"level": "标准", "crMin": 10, "crMax": 49,
     "desc": "舒适的生活水平，一日三餐，偶尔下馆子。住所：普通的家或公寓。外出住普通的旅馆。在现代来看，大概会有一辆自己的小车。"},
    {"level": "小康", "crMin": 50, "crMax": 89,
     "desc": "小康级别已经可以享受奢侈品的舒适了。住所：真材实料的住地，也许会有一些仆人。会住昂贵的宾馆。旅行：头等舱。"},
    {"level": "富裕", "crMin": 90, "crMax": 98,
     "desc": "富裕级别就是享受超级奢侈品的时候了。住所：豪华住所和有着大量仆人的庭院。住总统套房。旅行：头等舱。"},
    {"level": "富豪", "crMin": 99, "crMax": 99,
     "desc": "与富裕差不多，但钱已经只是一个代号了。你将是世界上最富有的人。"},
]

# 现金/资产倍率 (按时代与地区)  格式: [现金倍率, 资产倍率]
CURRENCY = [
    {"era": "1920年代", "region": "美国", "unit": "$", "mul": [["身无分文", 0.5, 0], ["拮据", 1, 10], ["标准", 2, 50], ["小康", 5, 500], ["富裕", 20, 2000], ["富豪", 50000, 5000000]]},
    {"era": "现代",    "region": "美国", "unit": "$", "mul": [["身无分文", 10, 0], ["拮据", 20, 200], ["标准", 40, 1000], ["小康", 100, 10000], ["富裕", 400, 40000], ["富豪", 1000000, 10000000]]},
    {"era": "维多利亚时代", "region": "英国", "unit": "£", "mul": [["身无分文", 5, 0], ["拮据", 1, 10], ["标准", 10, 20], ["小康", 12, 200], ["富裕", 50, 500], ["富豪", 150000, 300000]]},
    {"era": "2010年代", "region": "中国", "unit": "¥", "mul": [["身无分文", 100, 0], ["拮据", 100, 1000], ["标准", 200, 5000], ["小康", 500, 40000], ["富裕", 3000, 250000], ["富豪", 1000000, 1000000000]]},
    {"era": "2010年代", "region": "日本", "unit": "円", "mul": [["身无分文", 1000, 0], ["拮据", 2000, 20000], ["标准", 4000, 150000], ["小康", 12000, 1000000], ["富裕", 75000, 6000000], ["富豪", 30000000, 3000000000]]},
    {"era": "2010年代", "region": "澳大利亚", "unit": "A$", "mul": [["身无分文", 10, 0], ["拮据", 15, 110], ["标准", 30, 500], ["小康", 75, 900], ["富裕", 350, 30000], ["富豪", 1000000, 9000000]]},
]

write_module("assets.js", "COC_ASSETS", {
    "livingLevels": LIVING,
    "currencies": CURRENCY,
}, "资产参考表")

# ============================================================
# 8. 职业属性公式解析表 (把 "教育×4" / "教育×2＋敏捷×2" 解析成结构化)
# ============================================================
ATTR_ALIAS = {
    "力量": "str", "STR": "str", "体质": "con", "CON": "con",
    "体型": "siz", "SIZ": "siz", "敏捷": "dex", "DEX": "dex",
    "外貌": "app", "APP": "app", "智力": "int", "INT": "int",
    "意志": "pow", "POW": "pow", "教育": "edu", "EDU": "edu",
    "幸运": "luck", "LUCK": "luck",
}

if os.environ.get("VERBOSE"):
    print("总职业:", len(occupations))

print("\n数据层生成完毕 ->", OUT)
