# -*- coding: utf-8 -*-
"""
gen_skills.py — 生成 web/js/data/skills.js
数据来源：克苏鲁的呼唤第七版规则书 + 参考站 ttrpg.shinkan42.art 技能速查
主要修订：
  1. 组技能（格斗/射击/驾驶/生存/科学/学识/技艺/其他语言）改为「全部展开」，
     使 斗殴、射击（手枪）、科学（化学）等专攻在技能列表中直接可见可选。
  2. 补齐 格斗（矛）、科学的植物学/密码学/工程学/司法科学/气象学/药学/动物学。
  3. 修正 学问→学识（基础值 1）、外语→其他语言，与规则书用词一致。
  4. 妙手基础值维持 10（规则书值；部分民间速查表误作 5）。
  5. 补 技艺 的 绘画 / 写作 两个子项（参考站列出但原表缺失）。

对照 ttrpg.shinkan42.art「技能速查」逐条核对后，仅以下两处与该站不一致，
经查证均以 7e 规则书为准：
  · 妙手：规则书 10% ，该站作 5%（疑似沿用 6e 数值）
  · 电子学：规则书 1% ，该站作 10%（疑似与「电气维修 10%」混淆）
其余技能名称、基础值、专攻分项完全一致。
"""
import json, os

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, "web", "js", "data", "skills.js")

ANY = ["any"]


def sk(id_, name, cat, base, subskills=None, eras=None, desc="", flat=False, dyn=None):
    """构造一个技能定义
    subskills: [(名称, 基础值), ...]
    flat: 该组的所有子技能是否默认展开进技能列表
    dyn:  动态基础值标识（'edu' 母语取教育 / 'dex2' 闪避取敏捷半值）
    """
    d = {
        "id": id_, "name": name, "category": cat, "base": base,
        "special": bool(subskills),
        "subskills": [{"name": n, "base": b} for n, b in (subskills or [])],
        "eras": eras or ANY,
        "desc": desc,
    }
    if flat:
        d["flat"] = True
    if dyn:
        d["dyn"] = dyn
    return d


SKILLS = [
    # ---------------- 调查核心 ----------------
    sk("spot_hidden", "侦查", "探索", 25, desc="主动搜查场景，找出隐藏线索"),
    sk("listen", "聆听", "探索", 20, desc="注意到门后、隔壁、远处的声响"),
    sk("library", "图书馆使用", "知识", 20, desc="翻档案、查文献、找记录"),
    sk("psychology", "心理学", "交流", 10, desc="察觉对方是否说谎、情绪与动机"),
    sk("track", "追踪", "探索", 10, desc="沿痕迹追踪人、载具或动物"),

    # ---------------- 社交与语言 ----------------
    sk("persuade", "说服", "交流", 10, desc="诚恳有条理地讲道理"),
    sk("fast_talk", "话术", "交流", 5, desc="连珠快嘴，先把人绕晕再说"),
    sk("intimidate", "恐吓", "交流", 15, desc="施压威胁，逼人就范"),
    sk("charm", "取悦", "交流", 15, desc="迷人、恭维、讨人喜欢（旧译「魅惑」）"),
    sk("disguise", "乔装", "交流", 5, desc="化装改变外貌"),
    sk("language_own", "母语", "知识", 0, dyn="edu", desc="基础值 = 教育 EDU"),
    sk("language_other", "其他语言", "知识", 1, flat=True, desc="每门外语单独一项，基础值 1%", subskills=[
        ("拉丁语", 1), ("英语", 1), ("法语", 1), ("德语", 1), ("西班牙语", 1),
        ("意大利语", 1), ("俄语", 1), ("希腊语", 1), ("希伯来语", 1), ("阿拉伯语", 1),
        ("梵语", 1), ("汉语", 1), ("日语", 1), ("埃及语", 1), ("阿卡德语", 1),
    ]),

    # ---------------- 战斗 ----------------
    sk("fighting", "格斗", "战斗", 25, flat=True, desc="近身战斗，各流派单独加点", subskills=[
        ("斗殴", 25), ("刀剑", 20), ("斧", 15), ("矛", 20),
        ("绞索", 15), ("鞭", 5), ("链锯/连枷", 10),
    ]),
    sk("firearms", "射击", "战斗", 20, flat=True, desc="火器与射击武器，各类型单独加点", subskills=[
        ("手枪", 20), ("步枪/霰弹枪", 25), ("冲锋枪", 15),
        ("弓", 15), ("机枪/重武器/火焰喷射器", 10),
    ]),
    sk("throw", "投掷", "战斗", 20, desc="投掷石块、飞刀、手雷"),
    sk("dodge", "闪避", "战斗", 0, dyn="dex2", desc="基础值 = 敏捷 DEX 的一半；不占用技能点"),

    # ---------------- 学术与知识 ----------------
    sk("accounting", "会计", "知识", 5, desc="查账、理清资金流向"),
    sk("anthropology", "人类学", "知识", 1, desc="比较文化与习俗"),
    sk("appraise", "估价", "知识", 5, desc="判断物品价值"),
    sk("archaeology", "考古学", "知识", 1, desc="考古方法与文物"),
    sk("history", "历史", "知识", 5, desc="历史事件与人物"),
    sk("law", "法律", "知识", 5, desc="法律知识与程序"),
    sk("occult", "神秘学", "知识", 5, desc="民间神秘知识与传闻"),
    sk("science", "科学", "知识", 1, flat=True, desc="各学科单独加点；数学为 10%", subskills=[
        ("天文学", 1), ("生物学", 1), ("植物学", 1), ("化学", 1), ("密码学", 1),
        ("工程学", 1), ("司法科学", 1), ("地质学", 1), ("气象学", 1), ("数学", 10),
        ("药学", 1), ("物理学", 1), ("动物学", 1),
    ]),
    sk("lore", "学识", "自定义", 1, flat=True, desc="冷门杂学，领域单独加点（可选规则）", subskills=[
        ("文学", 1), ("军事", 1), ("棋艺", 1), ("梦境学识", 1),
        ("《死灵之书》学识", 1), ("UFO 学识", 1),
    ]),
    sk("cthulhu", "克苏鲁神话", "知识", 0, desc="车卡时不可加点，只能通过遭遇神话获得；每点降低理智上限"),

    # ---------------- 医疗 ----------------
    sk("first_aid", "急救", "生存", 30, desc="止血保命，稳定伤员"),
    sk("medicine", "医学", "知识", 1, desc="医生级的诊断与治疗"),
    sk("psychoanalysis", "精神分析", "知识", 1, desc="理智恢复的重要途径"),
    sk("hypnosis", "催眠", "知识", 1, eras=["modern"], desc="引导进入恍惚状态（非常规）"),

    # ---------------- 机动与户外 ----------------
    sk("drive_auto", "汽车驾驶", "其他", 20, desc="驾驶汽车"),
    sk("ride", "骑术", "其他", 5, desc="骑马"),
    sk("pilot", "驾驶", "其他", 1, flat=True, desc="载具类型单独加点", subskills=[
        ("飞行器", 1), ("船", 1),
    ]),
    sk("climb", "攀爬", "生存", 20, desc="爬墙、爬树、翻窗"),
    sk("jump", "跳跃", "生存", 20, desc="跳沟、跳窗台"),
    sk("swim", "游泳", "生存", 20, desc="水中行动"),
    sk("stealth", "潜行", "探索", 20, desc="悄悄移动不被发现"),
    sk("navigate", "领航", "探索", 10, desc="辨别方向"),
    sk("survival", "生存", "生存", 10, flat=True, desc="按地形环境单独加点", subskills=[
        ("沙漠", 10), ("极地", 10), ("海上", 10), ("丛林", 10),
        ("山地", 10), ("平原", 10), ("沼泽", 10),
    ]),
    sk("natural_world", "博物学", "知识", 10, desc="动植物的传统知识"),
    sk("animal", "驯兽", "生存", 5, desc="安抚与驱使动物"),
    sk("diving", "潜水", "生存", 1, eras=["modern"], desc="水肺潜水作业（非常规）"),
    sk("artillery", "炮术", "战斗", 1, eras=["1920s", "modern"], desc="火炮操作（非常规）"),
    sk("demolitions", "爆破", "战斗", 1, eras=["1920s", "modern"], desc="设置与解除炸药（非常规）"),

    # ---------------- 技术与手艺 ----------------
    sk("mech_repair", "机械维修", "其他", 10, desc="修理机械设备"),
    sk("elec_repair", "电气维修", "其他", 10, desc="修理电路电气"),
    sk("electronics", "电子学", "知识", 1, eras=["modern"], desc="电子设备排查维修（7e 规则书基础值 1%；切勿与「电气维修 10%」混淆）"),
    sk("computer", "计算机使用", "知识", 5, eras=["modern"], desc="电脑操作与编程（现代背景）"),
    sk("op_heavy", "操作重型机械", "其他", 1, desc="起重机、推土机等"),
    sk("locksmith", "锁匠", "探索", 1, desc="开锁"),
    sk("sleight", "妙手", "探索", 10, desc="扒窃、顺手牵羊（7e 规则书基础值 10%；6e 及部分民间速查表作 5%）"),
    sk("read_lips", "读唇", "探索", 1, desc="看懂别人说什么"),
    sk("art_craft", "技艺", "知识", 5, flat=True, desc="艺术与手艺，各门类单独加点", subskills=[
        ("表演", 5), ("美术", 5), ("绘画", 5), ("摄影", 5), ("伪造文书", 5), ("文学", 5),
        ("写作", 5), ("书法", 5), ("乐理", 5), ("厨艺", 5), ("裁缝", 5), ("理发", 5),
        ("建筑", 5), ("舞蹈", 5), ("酿酒", 5), ("捕鱼", 5), ("歌唱", 5),
        ("制陶", 5), ("雕塑", 5), ("杂技", 5), ("风水", 5), ("技术制图", 5),
        ("耕作", 5), ("打字", 5), ("速记", 5), ("木匠", 5), ("莫里斯舞", 5),
        ("歌剧歌唱", 5), ("粉刷匠与油漆工", 5), ("吹制玻璃管", 5),
    ]),

    # ---------------- 信用评级 ----------------
    sk("credit", "信用评级", "其他", 0, desc="不是普通技能：基础值 0，由职业决定范围，必须用职业点数购买"),
]

# 完整性自检
ids = [s["id"] for s in SKILLS]
assert len(ids) == len(set(ids)), "存在重复 id"
for s in SKILLS:
    if s["special"]:
        assert s["subskills"], s["id"] + " 标记为组技能但没有子技能"
        assert s.get("flat"), s["id"] + " 未标记 flat（组技能必须展开，否则专攻会被隐藏）"

# 校验动态基础值
for s in SKILLS:
    if s["id"] == "language_own":
        assert s["dyn"] == "edu"
    if s["id"] == "dodge":
        assert s["dyn"] == "dex2"

body = json.dumps(SKILLS, ensure_ascii=False, separators=(",", ":"))

flat_n = sum(len(s["subskills"]) for s in SKILLS if s.get("flat"))
plain_n = len([s for s in SKILLS if not s["special"]])
total_rows = plain_n + flat_n

with open(OUT, "w", encoding="utf-8") as f:
    f.write("/* 自动生成，请勿手改。源: gen_skills.py（COC 7e 规则书 + 参考站技能速查） */\n")
    f.write("/* 技能定义 %d 项；组技能专攻全部展开后，技能列表共 %d 行 */\n" % (len(SKILLS), total_rows))
    f.write("window.COC_SKILLS = " + body + ";\n")

print("已写入", OUT)
print("技能定义 %d 项（其中基础技能 %d、组技能 %d）" % (
    len(SKILLS), plain_n, len([s for s in SKILLS if s["special"]])))
print("组技能专攻展开后列表行数：%d" % total_rows)
spec = [s for s in SKILLS if s["special"]]
for s in spec:
    print("  %-8s %-10s %2d 项%s" % (s["id"], s["name"], len(s["subskills"]),
                                    "  [默认展开]" if s.get("flat") else ""))
