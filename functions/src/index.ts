import { setGlobalOptions } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getFirestore } from "firebase-admin/firestore";

setGlobalOptions({ maxInstances: 10 });

initializeApp();

function studentTopic(courseId: string) {
  return `curso_${courseId}_estudiantes`;
}

function teacherTopic(courseId: string) {
  return `curso_${courseId}_docente`;
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

const postMessages = [
  { title: "📦 Nuevo commit en el muro", body: "Tu profe hizo push de algo nuevo. Revisa el diff." },
  { title: "🚀 Deploy a producción", body: "Se publicó contenido nuevo. Ya está en prod, no en staging." },
  { title: "🔔 Nueva release", body: "Hay un update en el curso — cambios recién mergeados." },
  { title: "📋 Standup del profe", body: "Tu profesor compartió algo nuevo en el muro." },
  { title: "🟢 Build exitoso", body: "Nueva publicación disponible. Sin errores de compilación." },
  { title: "💾 git pull recomendado", body: "Hay contenido nuevo esperando en el repo del curso." },
];

const pollMessages = [
  { title: "🗳️ RFC abierto para votación", body: "Se necesita tu voto para tomar una decisión de equipo." },
  { title: "⚖️ Design review en curso", body: "Hay una encuesta activa — tu opinión pesa en el veredicto." },
  { title: "📊 Poll de sprint planning", body: "Se abrió una votación. Participa antes del cierre del sprint." },
  { title: "🤝 Consenso pendiente", body: "El equipo necesita tu voto para avanzar." },
  { title: "🚨 Encuesta en producción", body: "Hay una votación activa. No dejes que expire sin tu voto." },
];

const quizMessages = [
  { title: "⚡ Code review sorpresa", body: "Tu profesor lanzó una pregunta — el CI está corriendo el timer." },
  { title: "🐛 Debuggea esto rápido", body: "Nueva pregunta en vivo. Encuentra la respuesta antes que se agote el tiempo." },
  { title: "🏆 Leaderboard esperando", body: "Hay una pregunta activa — responde rápido y sube en el ranking." },
  { title: "🔥 Hotfix urgente", body: "Se lanzó una pregunta sorpresa. Responde antes del timeout." },
  { title: "🎯 Unit test en vivo", body: "Nueva pregunta del quiz. ¿Tu respuesta pasa el test?" },
];

async function notifyStudents(courseId: string, title: string, body: string, type: string) {
  console.log(`[notify] estudiantes → topic=${studentTopic(courseId)} type=${type}`);
  await getMessaging().send({
    topic: studentTopic(courseId),
    notification: { title, body },
    data: { type, courseId },
  });
}

async function notifyTeacher(courseId: string, title: string, body: string, type: string) {
  console.log(`[notify] docente → topic=${teacherTopic(courseId)} type=${type}`);
  await getMessaging().send({
    topic: teacherTopic(courseId),
    notification: { title, body },
    data: { type, courseId },
  });
}

export const onPostCreated = onDocumentCreated(
  "cursos/{courseId}/posts/{postId}",
  async (event) => {
    const courseId = event.params.courseId;
    const texto = (event.data?.data()?.texto as string | undefined)?.trim();
    const chosen = pickRandom(postMessages);
    const body = texto ? `${chosen.body} "${texto.slice(0, 60)}${texto.length > 60 ? "…" : ""}"` : chosen.body;

    await Promise.all([
      notifyStudents(courseId, chosen.title, body, "post"),
      notifyTeacher(courseId, "Publicación enviada", "Tu publicación ya está visible para los estudiantes", "post"),
    ]);
  }
);

export const onPollStarted = onDocumentCreated(
  "cursos/{courseId}/encuestas/{encuestaId}",
  async (event) => {
    const courseId = event.params.courseId;
    const question = (event.data?.data()?.pregunta as string | undefined) ?? "";
    const chosen = pickRandom(pollMessages);
    const body = question ? `${chosen.body} "${question}"` : chosen.body;

    await Promise.all([
      notifyStudents(courseId, chosen.title, body, "poll"),
      notifyTeacher(courseId, "Encuesta lanzada", "Tu encuesta ya está activa para los estudiantes", "poll"),
    ]);
  }
);

export const onQuizLaunched = onDocumentCreated(
  "cursos/{courseId}/sesionQuiz/{sesionId}",
  async (event) => {
    const courseId = event.params.courseId;
    const question = (event.data?.data()?.preguntaTexto as string | undefined) ?? "";
    const chosen = pickRandom(quizMessages);
    const body = question ? `${chosen.body} "${question}"` : chosen.body;

    await Promise.all([
      notifyStudents(courseId, chosen.title, body, "quiz"),
      notifyTeacher(courseId, "Pregunta desplegada", "Tu pregunta de quiz ya está activa para los estudiantes", "quiz"),
    ]);
  }
);


async function resolveCallerCourseAndRole(uid: string): Promise<{ courseId: string; role: string }> {
  const snapshot = await getFirestore().collection("usuarios").doc(uid).get();
  const data = snapshot.data();
  if (!data || typeof data.cursoId !== "string" || typeof data.rol !== "string") {
    console.log(`[subscribe] uid=${uid} sin perfil válido en usuarios/`, data);
    throw new HttpsError("failed-precondition", "No se encontró el perfil del usuario.");
  }
  console.log(`[subscribe] uid=${uid} cursoId=${data.cursoId} rol=${data.rol}`);
  return { courseId: data.cursoId, role: data.rol };
}

function topicForRole(courseId: string, role: string): string {
  return role === "docente" ? teacherTopic(courseId) : studentTopic(courseId);
}

function requireToken(data: unknown): string {
  const token = (data as { token?: unknown } | null | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new HttpsError("invalid-argument", "Falta el token de notificaciones.");
  }
  return token;
}

export const subscribeToNotifications = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const token = requireToken(request.data);
  const { courseId, role } = await resolveCallerCourseAndRole(request.auth.uid);
  const topic = topicForRole(courseId, role);

  console.log(`[subscribe] token=${token.slice(0, 12)}... → topic=${topic}`);
  await getMessaging().subscribeToTopic([token], topic);
  return { topic };
});

export const unsubscribeFromNotifications = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const token = requireToken(request.data);
  const { courseId, role } = await resolveCallerCourseAndRole(request.auth.uid);
  const topic = topicForRole(courseId, role);

  await getMessaging().unsubscribeFromTopic([token], topic);
  return { topic };
});