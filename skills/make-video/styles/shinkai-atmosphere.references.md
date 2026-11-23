# 新海诚空气感（shinkai-atmosphere）· 风格档案

## 适用场景
- story-narrative

## 视觉参数镜像
> 以下字段由 `shinkai-atmosphere.json` 机器对账，改动须同步两边。

| 字段 | 值 |
| --- | --- |
| 转场 | dissolve / whip-pan |
| 偏好场景 | atmosphere / depth-layers |
| 禁用场景 | chart / hierarchy-stack |
| 母题 | god-ray / lens-bloom / sky-gradient / reflective-puddle |

## 视觉语法
- 高饱和天空渐变 + 体积光斜射 + 镜头光晕；云层与光斑是情绪主体。
- 傍晚/雨后配色，地面湿反光做上下呼应；去掉人物正脸特写，留空位给天。
- 2D 光效分层叠加，禁止用 3D 机械字还原空气感。

## 代码可达边界
- A 级：渐变、体积光、光晕、湿地倒影、粒子雨全部由 Canvas/CSS 光效层参数化实现。
- 边界：手绘云层笔触与极高动态范围光斑为工艺天花板，不声明为已兑现。

## 来源与等级
- 等级 B（未对拍）：公开拆解可用于参数化，首条成片对拍后按 V-STYLE-005 结论升级。
