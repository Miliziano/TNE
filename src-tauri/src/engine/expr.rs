// ─── src-tauri/src/engine/expr.rs ──────────────────────────────────
//
// Interprete di espressioni per TMap e Filter.
// Valuta un ExprNode (l'AST già definito in src/ir/types.ts) a partire
// da una Row, producendo un Value.
//
// L'AST viene deserializzato dal JSON del Plan — il frontend costruisce
// l'albero come oggi, lo serializza, Rust lo interpreta.
//
// CONCETTI RUST NUOVI:
//
// 1. `Box<T>` — puntatore heap per tipi ricorsivi. Un ExprNode può
//    contenere altri ExprNode (es. BinaryOp ha left e right che sono
//    ExprNode). In Rust le struct non possono contenere se stesse
//    direttamente (dimensione infinita) — Box risolve mettendo il
//    figlio nello heap con dimensione nota (un puntatore = 8 byte).
//    Equivale a un riferimento in JS, ma con ownership esplicita.
//
// 2. `#[serde(rename_all = "camelCase")]` — deserializza i campi JSON
//    in camelCase (come il TypeScript) mappandoli ai field Rust in
//    snake_case. Così "leftExpr" nel JSON diventa `left_expr` in Rust.
//
// 3. `fn eval` ricorsiva — l'interprete chiama se stesso sui figli
//    dell'AST. In Rust le funzioni ricorsive funzionano normalmente,
//    ma se fossero async richiederebbero `Box::pin` (non è il caso qui
//    perché eval è sincrona — non fa I/O).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::engine::types::{Row, Value};

// ─── AST — speculare a ExprNode in src/ir/types.ts ───────────────

#[derive(Debug, Clone, Serialize, Deserialize,PartialEq)]
#[serde(tag = "kind")]
pub enum ExprNode {
    // Valori letterali
    #[serde(rename = "Literal", alias = "literal")]
    Literal {
        value: LiteralValue,
    },

    // Riferimento a un campo: $input.nome → FieldRef { input: "input", field: "nome" }
    #[serde(rename = "FieldRef", alias = "fieldRef")]
    FieldRef {
        input: String,   // nome dell'input TMap (es. "main", "lookup_1")
        field: String,   // nome del campo
    },

    // Riferimento diretto a campo senza prefisso input (usato in Filter)
    #[serde(rename = "DirectFieldRef", alias = "directFieldRef")]
    DirectFieldRef {
        field: String,
    },

    // Operazione binaria: left OP right
    #[serde(rename = "BinaryOp", alias = "binaryOp")]
    BinaryOp {
        op:    BinaryOperator,
        left:  Box<ExprNode>,
        right: Box<ExprNode>,
    },

    // Operazione unaria: NOT expr, -expr
    #[serde(rename = "UnaryOp", alias = "unaryOp")]
    UnaryOp {
        op:   UnaryOperator,
        expr: Box<ExprNode>,
    },

    // Chiamata a funzione built-in: TRIM(expr), UPPER(expr), ecc.
    #[serde(rename = "FunctionCall", alias = "functionCall")]
    FunctionCall {
        name: String,
        args: Vec<ExprNode>,
    },

    // CASE WHEN cond THEN val ... ELSE default END
    #[serde(rename = "CaseWhen", alias = "caseWhen")]
    CaseWhen {
        branches: Vec<CaseBranch>,
        default:  Option<Box<ExprNode>>,
    },

    // CAST(expr AS type)
    #[serde(rename = "Cast", alias = "cast")]
    Cast {
        expr:        Box<ExprNode>,
        target_type: String,   // "string" | "integer" | "float" | "boolean" | "date"
    },

    // Accesso a campo annidato: expr.field (per JSON/oggetti)
    #[serde(rename = "FieldAccess", alias = "fieldAccess")]
    FieldAccess {
        expr:  Box<ExprNode>,
        field: String,
    },

    // Null check esplicito
    #[serde(rename = "IsNull", alias = "isNull")]
    IsNull {
        expr: Box<ExprNode>,
    },

    #[serde(rename = "IsNotNull", alias = "isNotNull")]
    IsNotNull {
        expr: Box<ExprNode>,
    },

    // Coalesce: primo valore non-null
    #[serde(rename = "Coalesce", alias = "coalesce")]
    Coalesce {
        args: Vec<ExprNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize,PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaseBranch {
    pub condition: ExprNode,
    pub value:     ExprNode,
}

#[derive(Debug, Clone, Serialize, Deserialize,PartialEq)]
pub enum BinaryOperator {
    // Aritmetici
    #[serde(rename = "ADD", alias = "Add", alias = "add")] Add,
    #[serde(rename = "SUB", alias = "Sub", alias = "sub")] Sub,
    #[serde(rename = "MUL", alias = "Mul", alias = "mul")] Mul,
    #[serde(rename = "DIV", alias = "Div", alias = "div")] Div,
    #[serde(rename = "MOD", alias = "Mod", alias = "mod")] Mod,
    // Confronto
    #[serde(rename = "EQ",  alias = "Eq",  alias = "eq")]  Eq,
    #[serde(rename = "NE",  alias = "Ne",  alias = "ne")]  Ne,
    #[serde(rename = "LT",  alias = "Lt",  alias = "lt")]  Lt,
    #[serde(rename = "LTE", alias = "Lte", alias = "lte")] Lte,
    #[serde(rename = "GT",  alias = "Gt",  alias = "gt")]  Gt,
    #[serde(rename = "GTE", alias = "Gte", alias = "gte")] Gte,
    // Logici
    #[serde(rename = "AND", alias = "And", alias = "and")] And,
    #[serde(rename = "OR",  alias = "Or",  alias = "or")]  Or,
    // Stringa
    #[serde(rename = "CONCAT",   alias = "Concat",   alias = "concat")]   Concat,
    #[serde(rename = "COALESCE", alias = "Coalesce", alias = "coalesce")] Coalesce,
}

#[derive(Debug, Clone, Serialize, Deserialize,PartialEq)]
pub enum UnaryOperator {
    #[serde(rename = "NOT", alias = "Not", alias = "not")] Not,
    #[serde(rename = "NEG", alias = "Neg", alias = "neg")] Neg,
}

#[derive(Debug, Clone, Serialize, Deserialize,PartialEq)]
#[serde(untagged)]
pub enum LiteralValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
}

// ─── Contesto di valutazione ──────────────────────────────────────
// Contiene tutte le Row disponibili per la valutazione — una per
// ogni input TMap (main, lookup_1, ecc.) o una sola per il Filter.

pub struct EvalContext<'a> {
    // input_name → Row  (es. "main" → riga principale)
    pub inputs:    HashMap<&'a str, &'a Row>,
    // Variabili di lane
    pub variables: &'a HashMap<String, Value>,
}

impl<'a> EvalContext<'a> {
    pub fn single(row: &'a Row, variables: &'a HashMap<String, Value>) -> Self {
        let mut inputs = HashMap::new();
        inputs.insert("row", row);
        EvalContext { inputs, variables }
    }

    pub fn multi(inputs: HashMap<&'a str, &'a Row>, variables: &'a HashMap<String, Value>) -> Self {
        EvalContext { inputs, variables }
    }
}

// ─── Interprete ───────────────────────────────────────────────────

pub fn eval(expr: &ExprNode, ctx: &EvalContext) -> Value {
    match expr {
        ExprNode::Literal { value } => literal_to_value(value),

        ExprNode::FieldRef { input, field } => {
            ctx.inputs.get(input.as_str())
                .and_then(|row| row.get(field))
                .cloned()
                .unwrap_or(Value::Null)
        }

        ExprNode::DirectFieldRef { field } => {
            // Cerca prima nelle transform (priorità massima),
            // poi nella riga "row" (Filter), poi in tutti gli altri input
            if let Some(row) = ctx.inputs.get("__transforms__") {
                if let Some(v) = row.get(field) {
                    return v.clone();
                }
            }
            // Poi cerca in "row" (contesto Filter)
            if let Some(row) = ctx.inputs.get("row") {
                if let Some(v) = row.get(field) {
                    return v.clone();
                }
            }
            // Infine cerca in tutti gli altri input
            ctx.inputs.iter()
                .filter(|(k, _)| **k != "__transforms__" && **k != "row")
                .find_map(|(_, row)| row.get(field))
                .cloned()
                .unwrap_or(Value::Null)
        }

        ExprNode::BinaryOp { op, left, right } => {
            let l = eval(left, ctx);
            let r = eval(right, ctx);
            eval_binary(op, l, r)
        }

        ExprNode::UnaryOp { op, expr } => {
            let v = eval(expr, ctx);
            match op {
                UnaryOperator::Not => Value::Bool(!is_truthy(&v)),
                UnaryOperator::Neg => match v {
                    Value::Int(i)   => Value::Int(-i),
                    Value::Float(f) => Value::Float(-f),
                    _               => Value::Null,
                },
            }
        }

        ExprNode::FunctionCall { name, args } => {
            let evaluated: Vec<Value> = args.iter().map(|a| eval(a, ctx)).collect();
            eval_function(name, evaluated)
        }

        ExprNode::CaseWhen { branches, default } => {
            for branch in branches {
                let cond = eval(&branch.condition, ctx);
                if is_truthy(&cond) {
                    return eval(&branch.value, ctx);
                }
            }
            default.as_ref()
                .map(|d| eval(d, ctx))
                .unwrap_or(Value::Null)
        }

        ExprNode::Cast { expr, target_type } => {
            let v = eval(expr, ctx);
            cast_value(v, target_type)
        }

        ExprNode::FieldAccess { expr, field } => {
            match eval(expr, ctx) {
                Value::Object(obj) => {
                    obj.get(field)
                        .map(|v| Value::from_json(v.clone()))
                        .unwrap_or(Value::Null)
                }
                _ => Value::Null,
            }
        }

        ExprNode::IsNull { expr } => {
            Value::Bool(matches!(eval(expr, ctx), Value::Null))
        }

        ExprNode::IsNotNull { expr } => {
            Value::Bool(!matches!(eval(expr, ctx), Value::Null))
        }

        ExprNode::Coalesce { args } => {
            for arg in args {
                let v = eval(arg, ctx);
                if !matches!(v, Value::Null) { return v; }
            }
            Value::Null
        }
    }
}

// ─── Operatori binari ─────────────────────────────────────────────

fn eval_binary(op: &BinaryOperator, l: Value, r: Value) -> Value {
    eprintln!("[expr] op={:?} l={:?} r={:?}", op, l, r);
    match op {
        // Aritmetici
        BinaryOperator::Add => numeric_op(l.clone(), r.clone(), |a, b| a + b, |a, b| a + b)
            .unwrap_or_else(|| {
                // Fallback: concatenazione stringa se uno dei due è stringa
                Value::String(format!("{}{}", l_str(&l), l_str(&r)))
            }),
        BinaryOperator::Sub  => numeric_op(l, r, |a, b| a - b, |a, b| a - b).unwrap_or(Value::Null),
        BinaryOperator::Mul  => numeric_op(l, r, |a, b| a * b, |a, b| a * b).unwrap_or(Value::Null),
        BinaryOperator::Div  => {
            match (&l, &r) {
                (_, Value::Int(0))   => Value::Null,   // divisione per zero → Null
                (_, Value::Float(f)) if *f == 0.0 => Value::Null,
                _ => numeric_op(l, r, |a, b| a / b, |a, b| a / b).unwrap_or(Value::Null),
            }
        }
        BinaryOperator::Mod  => numeric_op(l, r, |a, b| a % b, |a, b| a % b).unwrap_or(Value::Null),

        // Confronto
        BinaryOperator::Eq  => Value::Bool(values_equal(&l, &r)),
        BinaryOperator::Ne  => Value::Bool(!values_equal(&l, &r)),
        BinaryOperator::Lt  => Value::Bool(compare_values(&l, &r) == Some(std::cmp::Ordering::Less)),
        BinaryOperator::Lte => Value::Bool(matches!(compare_values(&l, &r), Some(std::cmp::Ordering::Less) | Some(std::cmp::Ordering::Equal))),
        BinaryOperator::Gt  => Value::Bool(compare_values(&l, &r) == Some(std::cmp::Ordering::Greater)),
        BinaryOperator::Gte => Value::Bool(matches!(compare_values(&l, &r), Some(std::cmp::Ordering::Greater) | Some(std::cmp::Ordering::Equal))),

        // Logici (short-circuit già fatto a livello di BinaryOp eval)
        BinaryOperator::And => Value::Bool(is_truthy(&l) && is_truthy(&r)),
        BinaryOperator::Or  => Value::Bool(is_truthy(&l) || is_truthy(&r)),

        // Stringa
        BinaryOperator::Concat => Value::String(format!("{}{}", to_string(&l), to_string(&r))),

        BinaryOperator::Coalesce => {
            if !matches!(l, Value::Null) { l } else { r }
        }
    }
}

// ─── Funzioni built-in ────────────────────────────────────────────

fn eval_function(name: &str, args: Vec<Value>) -> Value {
    let name_lower = name.to_lowercase();
    match name_lower.as_str() {
        // ── Stringa ──────────────────────────────────────────────
        "trim" | "ltrim" | "rtrim" => {
            let s = to_string(args.first().unwrap_or(&Value::Null));
            Value::String(match name_lower.as_str() {
                "ltrim" => s.trim_start().to_string(),
                "rtrim" => s.trim_end().to_string(),
                _       => s.trim().to_string(),
            })
        }
        "upper"       => Value::String(to_string(args.first().unwrap_or(&Value::Null)).to_uppercase()),
        "lower"       => Value::String(to_string(args.first().unwrap_or(&Value::Null)).to_lowercase()),
        "length" | "len" => {
            Value::Int(to_string(args.first().unwrap_or(&Value::Null)).len() as i64)
        }
        "substring" | "substr" => {
            let s     = to_string(args.first().unwrap_or(&Value::Null));
            let start = to_int(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0).max(0) as usize;
            let len   = args.get(2).and_then(|v| to_int(v)).map(|l| l as usize);
            let chars: Vec<char> = s.chars().collect();
            let slice = if let Some(l) = len {
                chars[start.min(chars.len())..((start + l).min(chars.len()))].iter().collect()
            } else {
                chars[start.min(chars.len())..].iter().collect()
            };
            Value::String(slice)
        }
        "replace" => {
            let s    = to_string(args.first().unwrap_or(&Value::Null));
            let from = to_string(args.get(1).unwrap_or(&Value::Null));
            let to   = to_string(args.get(2).unwrap_or(&Value::Null));
            Value::String(s.replace(&from, &to))
        }
        "concat" => {
            Value::String(args.iter().map(to_string).collect::<Vec<_>>().join(""))
        }
        "concat_ws" => {
            let sep = to_string(args.first().unwrap_or(&Value::Null));
            let parts: Vec<String> = args[1..].iter()
                .filter(|v| !matches!(v, Value::Null))
                .map(to_string).collect();
            Value::String(parts.join(&sep))
        }
        "left" => {
            let s = to_string(args.first().unwrap_or(&Value::Null));
            let n = to_int(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0).max(0) as usize;
            Value::String(s.chars().take(n).collect())
        }
        "right" => {
            let s     = to_string(args.first().unwrap_or(&Value::Null));
            let n     = to_int(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0).max(0) as usize;
            let chars: Vec<char> = s.chars().collect();
            let start = chars.len().saturating_sub(n);
            Value::String(chars[start..].iter().collect())
        }
        "contains" => {
            let s      = to_string(args.first().unwrap_or(&Value::Null));
            let needle = to_string(args.get(1).unwrap_or(&Value::Null));
            Value::Bool(s.contains(&needle))
        }
        "starts_with" => {
            let s      = to_string(args.first().unwrap_or(&Value::Null));
            let prefix = to_string(args.get(1).unwrap_or(&Value::Null));
            Value::Bool(s.starts_with(&prefix))
        }
        "ends_with" => {
            let s      = to_string(args.first().unwrap_or(&Value::Null));
            let suffix = to_string(args.get(1).unwrap_or(&Value::Null));
            Value::Bool(s.ends_with(&suffix))
        }
        "pad_left" | "lpad" => {
            let s   = to_string(args.first().unwrap_or(&Value::Null));
            let len = to_int(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0).max(0) as usize;
            let pad = to_string(args.get(2).unwrap_or(&Value::String(" ".to_string())));
            let pad_char = pad.chars().next().unwrap_or(' ');
            if s.len() >= len { return Value::String(s); }
            let padding: String = std::iter::repeat(pad_char).take(len - s.len()).collect();
            Value::String(format!("{}{}", padding, s))
        }
        "pad_right" | "rpad" => {
            let s   = to_string(args.first().unwrap_or(&Value::Null));
            let len = to_int(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0).max(0) as usize;
            let pad = to_string(args.get(2).unwrap_or(&Value::String(" ".to_string())));
            let pad_char = pad.chars().next().unwrap_or(' ');
            if s.len() >= len { return Value::String(s); }
            let padding: String = std::iter::repeat(pad_char).take(len - s.len()).collect();
            Value::String(format!("{}{}", s, padding))
        }
        "regex_match" => {
            // Senza la crate regex per ora — verifica contains come fallback
            let s       = to_string(args.first().unwrap_or(&Value::Null));
            let pattern = to_string(args.get(1).unwrap_or(&Value::Null));
            Value::Bool(s.contains(&pattern))  // TODO: usare crate regex in Fase 6b
        }

        // ── Numeriche ────────────────────────────────────────────
        "abs" => {
            match args.first().unwrap_or(&Value::Null) {
                Value::Int(i)   => Value::Int(i.abs()),
                Value::Float(f) => Value::Float(f.abs()),
                v               => Value::Float(to_float(v).unwrap_or(0.0).abs()),
            }
        }
        "round" => {
            let v = args.first().unwrap_or(&Value::Null);
            let d = to_int(args.get(1).unwrap_or(&Value::Int(0))).unwrap_or(0);
            if let Some(f) = to_float(v) {
                let factor = 10f64.powi(d as i32);
                Value::Float((f * factor).round() / factor)
            } else { Value::Null }
        }
        "ceil"  => to_float(args.first().unwrap_or(&Value::Null)).map(|f| Value::Int(f.ceil() as i64)).unwrap_or(Value::Null),
        "floor" => to_float(args.first().unwrap_or(&Value::Null)).map(|f| Value::Int(f.floor() as i64)).unwrap_or(Value::Null),
        "sqrt"  => to_float(args.first().unwrap_or(&Value::Null)).map(|f| Value::Float(f.sqrt())).unwrap_or(Value::Null),
        "power" | "pow" => {
            let base = to_float(args.first().unwrap_or(&Value::Null)).unwrap_or(0.0);
            let exp  = to_float(args.get(1).unwrap_or(&Value::Null)).unwrap_or(0.0);
            Value::Float(base.powf(exp))
        }
        "min" => {
            args.into_iter().filter(|v| !matches!(v, Value::Null))
                .min_by(|a, b| compare_values(a, b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(Value::Null)
        }
        "max" => {
            args.into_iter().filter(|v| !matches!(v, Value::Null))
                .max_by(|a, b| compare_values(a, b).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap_or(Value::Null)
        }

        // ── Conversione ──────────────────────────────────────────
        "to_string" | "str"   => Value::String(to_string(args.first().unwrap_or(&Value::Null))),
        "to_int"    | "int"   => to_int(args.first().unwrap_or(&Value::Null)).map(Value::Int).unwrap_or(Value::Null),
        "to_float"  | "float" => to_float(args.first().unwrap_or(&Value::Null)).map(Value::Float).unwrap_or(Value::Null),
        "to_bool"   | "bool"  => Value::Bool(is_truthy(args.first().unwrap_or(&Value::Null))),

        // ── Null handling ────────────────────────────────────────
        "coalesce" | "ifnull" | "nvl" => {
            args.into_iter().find(|v| !matches!(v, Value::Null)).unwrap_or(Value::Null)
        }
        "nullif" => {
            let a = args.first().cloned().unwrap_or(Value::Null);
            let b = args.get(1).cloned().unwrap_or(Value::Null);
            if values_equal(&a, &b) { Value::Null } else { a }
        }
        "iif" | "if" => {
            let cond  = args.first().unwrap_or(&Value::Null);
            let true_v  = args.get(1).cloned().unwrap_or(Value::Null);
            let false_v = args.get(2).cloned().unwrap_or(Value::Null);
            if is_truthy(cond) { true_v } else { false_v }
        }

        // ── Data/ora ─────────────────────────────────────────────
        "now" | "current_timestamp" => {
            Value::DateTime(chrono::Utc::now().to_rfc3339())
        }
        "today" | "current_date" => {
            Value::Date(chrono::Utc::now().format("%Y-%m-%d").to_string())
        }
        "date_format" => {
            let dt  = to_string(args.first().unwrap_or(&Value::Null));
            let fmt = to_string(args.get(1).unwrap_or(&Value::Null));
            // Conversione formato SQL → chrono: %Y %m %d %H %M %S
            Value::String(dt)  // TODO: parsing date completo in Fase 6b
        }
        "year" | "month" | "day" | "hour" | "minute" | "second" => {
            let dt = to_string(args.first().unwrap_or(&Value::Null));
            // Parsing date semplificato
            if let Ok(parsed) = chrono::NaiveDate::parse_from_str(&dt, "%Y-%m-%d") {
                match name_lower.as_str() {
                    "year"  => Value::Int(parsed.format("%Y").to_string().parse().unwrap_or(0)),
                    "month" => Value::Int(parsed.format("%-m").to_string().parse().unwrap_or(0)),
                    "day"   => Value::Int(parsed.format("%-d").to_string().parse().unwrap_or(0)),
                    _       => Value::Null,
                }
            } else { Value::Null }
        }

        // Funzione sconosciuta → Null con warning in eprintln
        unknown => {
            eprintln!("[engine/expr] funzione '{}' non implementata", unknown);
            Value::Null
        }
    }
}

// ─── Cast esplicito ───────────────────────────────────────────────

fn cast_value(v: Value, target: &str) -> Value {
    match target {
        "string"  | "text"    => Value::String(to_string(&v)),
        "integer" | "int"     => to_int(&v).map(Value::Int).unwrap_or(Value::Null),
        "float"   | "decimal" => to_float(&v).map(Value::Float).unwrap_or(Value::Null),
        "boolean" | "bool"    => Value::Bool(is_truthy(&v)),
        "date"    => {
            let s = to_string(&v);
            // Prova vari formati comuni
            for fmt in &["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y%m%d"] {
                if chrono::NaiveDate::parse_from_str(&s, fmt).is_ok() {
                    return Value::Date(
                        chrono::NaiveDate::parse_from_str(&s, fmt)
                            .unwrap()
                            .format("%Y-%m-%d")
                            .to_string()
                    );
                }
            }
            Value::Null
        }
        _ => v,
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

fn literal_to_value(lit: &LiteralValue) -> Value {
    match lit {
        LiteralValue::Null      => Value::Null,
        LiteralValue::Bool(b)   => Value::Bool(*b),
        LiteralValue::Int(i)    => Value::Int(*i),
        LiteralValue::Float(f)  => Value::Float(*f),
        LiteralValue::String(s) => Value::String(s.clone()),
    }
}

pub fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null      => false,
        Value::Bool(b)   => *b,
        Value::Int(i)    => *i != 0,
        Value::Float(f)  => *f != 0.0,
        Value::String(s) => !s.is_empty() && s != "false" && s != "0",
        Value::Object(_) => true,
        Value::Date(_) | Value::DateTime(_) => true,
    }
}

fn to_string(v: &Value) -> String {
    v.as_str_repr()
}

fn to_int(v: &Value) -> Option<i64> {
    match v {
        Value::Int(i)   => Some(*i),
        Value::Float(f) => Some(*f as i64),
        Value::Bool(b)  => Some(if *b { 1 } else { 0 }),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn to_float(v: &Value) -> Option<f64> {
    match v {
        Value::Int(i)    => Some(*i as f64),
        Value::Float(f)  => Some(*f),
        Value::Bool(b)   => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Null, _) | (_, Value::Null) => false,
        (Value::Bool(x), Value::Bool(y))   => x == y,
        (Value::Int(x),  Value::Int(y))    => x == y,
        (Value::Float(x), Value::Float(y)) => (x - y).abs() < f64::EPSILON,
        (Value::Int(x), Value::Float(y))   => (*x as f64 - y).abs() < f64::EPSILON,
        (Value::Float(x), Value::Int(y))   => (x - *y as f64).abs() < f64::EPSILON,
        (Value::String(x), Value::String(y)) => x == y,
        _ => a.as_str_repr() == b.as_str_repr(),
    }
}

fn compare_values(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (Value::Null, Value::Null) => Some(std::cmp::Ordering::Equal),
        (Value::Null, _)           => Some(std::cmp::Ordering::Less),
        (_, Value::Null)           => Some(std::cmp::Ordering::Greater),
        (Value::Int(x),   Value::Int(y))   => Some(x.cmp(y)),
        (Value::Float(x), Value::Float(y)) => x.partial_cmp(y),
        (Value::Int(x),   Value::Float(y)) => (*x as f64).partial_cmp(y),
        (Value::Float(x), Value::Int(y))   => x.partial_cmp(&(*y as f64)),
        (Value::String(x), Value::String(y)) => Some(x.cmp(y)),
        _ => Some(a.as_str_repr().cmp(&b.as_str_repr())),
    }
}

fn numeric_op(
    l: Value, r: Value,
    int_op:   impl Fn(i64, i64) -> i64,
    float_op: impl Fn(f64, f64) -> f64,
) -> Option<Value> {
    match (&l, &r) {
        (Value::Int(a),   Value::Int(b))   => Some(Value::Int(int_op(*a, *b))),
        (Value::Float(a), Value::Float(b)) => Some(Value::Float(float_op(*a, *b))),
        (Value::Int(a),   Value::Float(b)) => Some(Value::Float(float_op(*a as f64, *b))),
        (Value::Float(a), Value::Int(b))   => Some(Value::Float(float_op(*a, *b as f64))),
        _ => None,
    }
}

// Helper per Add stringa — evita borrow checker issues
fn l_str(v: &Value) -> String { v.as_str_repr() }