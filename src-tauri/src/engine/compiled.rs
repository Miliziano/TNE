// ─── src-tauri/src/engine/compiled.rs ─────────────────────────────
// Espressioni FPEL COMPILATE una volta all'avvio del nodo (P383, voce B di
// docs/STUDIO-motore-prestazioni.md).
//
// L'interprete (`expr::eval`) rilegge l'albero a ogni riga: converte i
// letterali, normalizza il nome della funzione, riconosce `var(...)`, copia i
// valori letti dalla riga anche solo per confrontarli. Qui tutto ciò che non
// dipende dalla riga si fa UNA volta:
//   - letterali già convertiti in Value, e sotto-alberi costanti calcolati
//     (operatori, negazione, cast fra costanti);
//   - nome della funzione già in minuscolo; `var("X")` riconosciuto prima;
//   - i valori della riga si leggono IN PRESTITO (Cow): confronti, aritmetica,
//     IS NULL e i rami di CASE non copiano niente; si copia solo quando un
//     valore finisce davvero nel risultato o in una funzione;
//   - AND / OR si fermano appena il risultato è deciso.
//
// SEMANTICA IDENTICA all'interprete: lo verifica `tests::equivalente_all_interprete`
// su un corpus di espressioni e righe. Le funzioni restano quelle di
// `expr::eval_function` (stesso catalogo, stesso codice).

use std::borrow::Cow;
use crate::engine::expr::{
    cast_value, eval_binary_ref, eval_function, is_truthy, literal_to_value, to_string,
    BinaryOperator, EvalContext, ExprNode, UnaryOperator,
};
use crate::engine::types::Value;

static NULL: Value = Value::Null;

#[derive(Debug, Clone)]
pub struct Compiled(C);

#[derive(Debug, Clone)]
enum C {
    Const(Value),
    Field { input: String, field: String },
    Direct { field: String },
    Bin { op: BinaryOperator, l: Box<C>, r: Box<C> },
    And(Box<C>, Box<C>),
    Or(Box<C>, Box<C>),
    Not(Box<C>),
    Neg(Box<C>),
    VarConst(String),
    VarDyn(Box<C>),
    VarNone,
    Call { name: Box<str>, args: Vec<C> },
    Case { branches: Vec<(C, C)>, default: Option<Box<C>> },
    Cast { e: Box<C>, target: String },
    FieldAccess { e: Box<C>, field: String },
    IsNull(Box<C>),
    IsNotNull(Box<C>),
    Coalesce(Vec<C>),
}

impl Compiled {
    pub fn new(e: &ExprNode) -> Self {
        Compiled(compile(e))
    }

    /// Valuta l'espressione sulla riga del contesto. Stesso risultato di
    /// `expr::eval` sullo stesso albero.
    pub fn eval(&self, ctx: &EvalContext) -> Value {
        ev(&self.0, ctx).into_owned()
    }

    /// Solo la verità del risultato (filtri, condizioni): non copia nulla se
    /// il risultato è un valore letto dalla riga.
    pub fn is_true(&self, ctx: &EvalContext) -> bool {
        is_truthy(&ev(&self.0, ctx))
    }
}

fn negate(v: &Value) -> Value {
    match v {
        Value::Int(i) => Value::Int(-i),
        Value::Float(f) => Value::Float(-f),
        _ => Value::Null,
    }
}

fn compile(e: &ExprNode) -> C {
    match e {
        ExprNode::Literal { value } => C::Const(literal_to_value(value)),
        ExprNode::FieldRef { input, field } => C::Field { input: input.clone(), field: field.clone() },
        ExprNode::DirectFieldRef { field } => C::Direct { field: field.clone() },
        ExprNode::BinaryOp { op, left, right } => {
            let (l, r) = (compile(left), compile(right));
            if let (C::Const(a), C::Const(b)) = (&l, &r) {
                return C::Const(eval_binary_ref(op, a, b));
            }
            match op {
                BinaryOperator::And => C::And(Box::new(l), Box::new(r)),
                BinaryOperator::Or => C::Or(Box::new(l), Box::new(r)),
                _ => C::Bin { op: op.clone(), l: Box::new(l), r: Box::new(r) },
            }
        }
        ExprNode::UnaryOp { op, expr } => {
            let inner = compile(expr);
            if let C::Const(v) = &inner {
                return C::Const(match op {
                    UnaryOperator::Not => Value::Bool(!is_truthy(v)),
                    UnaryOperator::Neg => negate(v),
                });
            }
            match op {
                UnaryOperator::Not => C::Not(Box::new(inner)),
                UnaryOperator::Neg => C::Neg(Box::new(inner)),
            }
        }
        ExprNode::FunctionCall { name, args } => {
            if name.eq_ignore_ascii_case("var") {
                return match args.first() {
                    None => C::VarNone,
                    Some(a) => match compile(a) {
                        C::Const(v) => C::VarConst(to_string(&v)),
                        other => C::VarDyn(Box::new(other)),
                    },
                };
            }
            // Le funzioni NON si piegano a costante: alcune dipendono dal momento
            // (now, uuid…). Si risolve solo il nome, una volta.
            C::Call { name: name.to_lowercase().into_boxed_str(), args: args.iter().map(compile).collect() }
        }
        ExprNode::CaseWhen { branches, default } => C::Case {
            branches: branches.iter().map(|b| (compile(&b.condition), compile(&b.value))).collect(),
            default: default.as_ref().map(|d| Box::new(compile(d))),
        },
        ExprNode::Cast { expr, target_type } => {
            let inner = compile(expr);
            if let C::Const(v) = &inner {
                return C::Const(cast_value(v.clone(), target_type));
            }
            C::Cast { e: Box::new(inner), target: target_type.clone() }
        }
        ExprNode::FieldAccess { expr, field } => C::FieldAccess { e: Box::new(compile(expr)), field: field.clone() },
        ExprNode::IsNull { expr } => C::IsNull(Box::new(compile(expr))),
        ExprNode::IsNotNull { expr } => C::IsNotNull(Box::new(compile(expr))),
        ExprNode::Coalesce { args } => C::Coalesce(args.iter().map(compile).collect()),
    }
}

fn ev<'a, 'c: 'a>(c: &'a C, ctx: &EvalContext<'c>) -> Cow<'a, Value> {
    match c {
        C::Const(v) => Cow::Borrowed(v),
        C::Field { input, field } => Cow::Borrowed(ctx.field(input, field).unwrap_or(&NULL)),
        C::Direct { field } => Cow::Borrowed(ctx.direct_field(field).unwrap_or(&NULL)),
        C::Bin { op, l, r } => {
            let (a, b) = (ev(l, ctx), ev(r, ctx));
            Cow::Owned(eval_binary_ref(op, &a, &b))
        }
        // L'interprete calcola entrambi i lati e poi combina: il risultato è lo
        // stesso fermandosi prima (le espressioni non hanno effetti collaterali).
        C::And(l, r) => Cow::Owned(Value::Bool(is_truthy(&ev(l, ctx)) && is_truthy(&ev(r, ctx)))),
        C::Or(l, r) => Cow::Owned(Value::Bool(is_truthy(&ev(l, ctx)) || is_truthy(&ev(r, ctx)))),
        C::Not(e) => Cow::Owned(Value::Bool(!is_truthy(&ev(e, ctx)))),
        C::Neg(e) => Cow::Owned(negate(&ev(e, ctx))),
        C::VarConst(name) => Cow::Owned(ctx.variables.get(name).cloned().unwrap_or(Value::Null)),
        C::VarDyn(e) => {
            let name = to_string(&ev(e, ctx));
            Cow::Owned(ctx.variables.get(&name).cloned().unwrap_or(Value::Null))
        }
        C::VarNone => Cow::Borrowed(&NULL),
        C::Call { name, args } => {
            let vals: Vec<Value> = args.iter().map(|a| ev(a, ctx).into_owned()).collect();
            Cow::Owned(eval_function(name, vals))
        }
        C::Case { branches, default } => {
            for (cond, val) in branches {
                if is_truthy(&ev(cond, ctx)) {
                    return ev(val, ctx);
                }
            }
            match default {
                Some(d) => ev(d, ctx),
                None => Cow::Borrowed(&NULL),
            }
        }
        C::Cast { e, target } => Cow::Owned(cast_value(ev(e, ctx).into_owned(), target)),
        C::FieldAccess { e, field } => match ev(e, ctx).as_ref() {
            Value::Object(obj) => Cow::Owned(obj.get(field).map(|v| Value::from_json(v.clone())).unwrap_or(Value::Null)),
            _ => Cow::Borrowed(&NULL),
        },
        C::IsNull(e) => Cow::Owned(Value::Bool(matches!(ev(e, ctx).as_ref(), Value::Null))),
        C::IsNotNull(e) => Cow::Owned(Value::Bool(!matches!(ev(e, ctx).as_ref(), Value::Null))),
        C::Coalesce(args) => {
            for a in args {
                let v = ev(a, ctx);
                if !matches!(v.as_ref(), Value::Null) {
                    return v;
                }
            }
            Cow::Borrowed(&NULL)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::expr::eval;
    use crate::engine::types::Row;
    use serde_json::json;
    use std::collections::HashMap;

    fn row(v: serde_json::Value) -> Row {
        Row::from_json_object(v.as_object().unwrap().clone())
    }

    /// Ogni espressione del corpus dà lo stesso risultato compilata e
    /// interpretata, su righe diverse (valori presenti, assenti, null, tipi misti).
    #[test]
    fn equivalente_all_interprete() {
        let f = |n: &str| json!({"kind":"DirectFieldRef","field": n});
        let q = |i: &str, n: &str| json!({"kind":"FieldRef","input": i,"field": n});
        let lit = |v: serde_json::Value| json!({"kind":"Literal","value": v});
        let bin = |op: &str, l: serde_json::Value, r: serde_json::Value| json!({"kind":"BinaryOp","op": op,"left": l,"right": r});
        let call = |n: &str, a: Vec<serde_json::Value>| json!({"kind":"FunctionCall","name": n,"args": a});
        let corpus = vec![
            f("qty"), q("main", "name"), q("lkp", "city"), q("nessuno", "x"), f("assente"),
            lit(json!(3)), lit(json!("testo")), lit(json!(null)), lit(json!(true)), lit(json!(2.5)),
            bin("MUL", call("to_float", vec![f("qty")]), call("to_float", vec![f("price")])),
            bin("ADD", f("name"), lit(json!(" x"))), bin("ADD", f("qty"), lit(json!(1))),
            bin("ADD", lit(json!(1)), lit(json!(2))), bin("DIV", f("qty"), lit(json!(0))),
            bin("SUB", f("n"), f("m")), bin("MOD", f("n"), lit(json!(3))),
            bin("GT", f("qty"), lit(json!(5))), bin("LTE", f("price"), lit(json!("10"))),
            bin("EQ", f("name"), lit(json!("cliente 7"))), bin("NE", f("nulla"), lit(json!(null))),
            bin("AND", bin("GT", f("qty"), lit(json!(1))), f("flag")),
            bin("OR", f("assente"), bin("LT", f("qty"), lit(json!(3)))),
            bin("CONCAT", f("city"), f("qty")), bin("COALESCE", f("nulla"), f("name")),
            json!({"kind":"UnaryOp","op":"NOT","expr": f("flag")}),
            json!({"kind":"UnaryOp","op":"NEG","expr": f("n")}),
            json!({"kind":"UnaryOp","op":"NEG","expr": lit(json!(4))}),
            call("upper", vec![f("name")]), call("UPPER", vec![f("name")]),
            call("concat", vec![f("city"), lit(json!("-")), f("qty")]),
            call("coalesce", vec![f("nulla"), f("assente"), lit(json!("d"))]),
            call("length", vec![f("name")]), call("substring", vec![f("name"), lit(json!(1)), lit(json!(3))]),
            call("var", vec![lit(json!("SOGLIA"))]), call("var", vec![f("nome_var")]), call("var", vec![]),
            json!({"kind":"CaseWhen","branches":[{"condition": bin("GT", f("qty"), lit(json!(5))),"value": lit(json!("alto"))},
                                                {"condition": f("flag"),"value": f("name")}],"default": f("city")}),
            json!({"kind":"CaseWhen","branches":[{"condition": f("assente"),"value": lit(json!(1))}],"default": null}),
            json!({"kind":"Cast","expr": f("qty"),"target_type":"integer"}),
            json!({"kind":"Cast","expr": lit(json!("12")),"target_type":"float"}),
            json!({"kind":"Cast","expr": f("d"),"target_type":"date"}),
            json!({"kind":"FieldAccess","expr": f("obj"),"field":"a"}),
            json!({"kind":"FieldAccess","expr": f("name"),"field":"a"}),
            json!({"kind":"IsNull","expr": f("nulla")}), json!({"kind":"IsNotNull","expr": f("qty")}),
            json!({"kind":"Coalesce","args":[f("nulla"), f("assente"), f("qty")]}),
            json!({"kind":"Coalesce","args":[f("nulla")]}),
        ];
        let rows = vec![
            json!({"qty":"7","price":"12.5","name":"cliente 7","city":"Roma","flag":true,"n":10,"m":2.5,"nulla":null,"nome_var":"SOGLIA","d":"31/10/2026","obj":{"a":1}}),
            json!({"qty":2,"price":3.0,"name":"","city":null,"flag":"false","n":-1,"m":0,"nome_var":"ALTRO"}),
            json!({}),
        ];
        let lkp = row(json!({"city":"Torino","qty":"99"}));
        let mut vars = HashMap::new();
        vars.insert("SOGLIA".to_string(), Value::String("50".into()));
        vars.insert("ALTRO".to_string(), Value::Int(3));
        for r in &rows {
            let main = row(r.clone());
            for e in &corpus {
                let node: ExprNode = serde_json::from_value(e.clone()).unwrap();
                let c = Compiled::new(&node);
                for main_input in [None, Some("main")] {
                    let ctx = || EvalContext::from_pairs([("main", &main), ("row", &main), ("lkp", &lkp)], &vars, main_input);
                    let a = format!("{:?}", eval(&node, &ctx()));
                    let b = format!("{:?}", c.eval(&ctx()));
                    assert_eq!(a, b, "espressione {e} sulla riga {r}");
                    assert_eq!(is_truthy(&eval(&node, &ctx())), c.is_true(&ctx()), "verità di {e}");
                }
            }
        }
    }

    #[test]
    fn costanti_calcolate_una_volta() {
        let e: ExprNode = serde_json::from_value(json!({"kind":"BinaryOp","op":"ADD",
            "left":{"kind":"Literal","value":2},"right":{"kind":"Literal","value":3}})).unwrap();
        assert!(matches!(Compiled::new(&e).0, C::Const(Value::Int(5))));
        let e: ExprNode = serde_json::from_value(json!({"kind":"FunctionCall","name":"var",
            "args":[{"kind":"Literal","value":"X"}]})).unwrap();
        assert!(matches!(Compiled::new(&e).0, C::VarConst(_)));
    }
}
