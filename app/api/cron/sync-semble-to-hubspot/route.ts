import { NextResponse } from "next/server";

const UNUSABLE_EMAILS = new Set([
  "bookings@nationwidepathology.co.uk",
  "care.vl4me@nhs.net",
  "alanjcollett@gmail.com",
]);
const HUBSPOT_CALL_DELAY_MS = 200;
const HUBSPOT_RETRY_DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeEmail(email?: string | null): string | undefined {
  if (!email) {
    return undefined;
  }

  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.indexOf("@");
  const dotIndex = trimmed.lastIndexOf(".");

  if (atIndex <= 0 || dotIndex <= atIndex + 1 || dotIndex === trimmed.length - 1) {
    return undefined;
  }

  if (UNUSABLE_EMAILS.has(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export async function GET() {
  const pageSize = 100;
  let page = 1;
  let totalFetched = 0;
  let totalSkippedNoPhone = 0;
  let totalCreated = 0;
  let totalBackfilled = 0;
  let totalUpdatedBySembleId = 0;
  let totalMatchedByNamePhone = 0;
  let totalMatchedByNameEmail = 0;
  let totalFailed = 0;
  const failedPatients: Array<{
    patientId: string;
    name: string;
    email: string | null;
    phone: string;
    status: number | null;
    error: string;
  }> = [];

  try {
    const fetchHubSpot = async (url: string, init: RequestInit) => {
      await sleep(HUBSPOT_CALL_DELAY_MS);
      let response = await fetch(url, init);
      if (response.status === 429) {
        await sleep(HUBSPOT_RETRY_DELAY_MS);
        response = await fetch(url, init);
      }
      return response;
    };

    const searchContact = async (
      filters: Array<{
        propertyName: string;
        operator: "EQ";
        value: string;
      }>,
    ) => {
      const searchResponse = await fetchHubSpot(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            filterGroups: [
              {
                filters,
              },
            ],
            limit: 1,
          }),
        },
      );

      if (!searchResponse.ok) {
        const errorBody = await searchResponse.text();
        throw new Error(errorBody || "Failed to search HubSpot contact");
      }

      const searchData = await searchResponse.json();
      return searchData?.results?.[0]?.id as string | undefined;
    };

    const upsertWithEmailRetry = async (
      method: "PATCH" | "POST",
      url: string,
      properties: Record<string, string>,
    ) => {
      const runRequest = async (requestProperties: Record<string, string>) =>
        fetchHubSpot(url, {
          method,
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN!}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ properties: requestProperties }),
        });

      let response = await runRequest(properties);
      if (response.ok) {
        return response;
      }

      const hasEmail = Boolean(properties.email);
      if (hasEmail && response.status === 409) {
        const retryProperties = { ...properties };
        delete retryProperties.email;
        response = await runRequest(retryProperties);
      }

      return response;
    };

    while (true) {
      const sembleResponse = await fetch(process.env.SEMBLE_API_URL!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-token": process.env.SEMBLE_API_KEY!,
        },
        body: JSON.stringify({
          query: `
            query {
              patients(pagination: { page: ${page}, pageSize: 100 }) {
                data {
                  id
                  firstName
                  lastName
                  email
                  phones {
                    phoneType
                    phoneNumber
                  }
                }
              }
            }
          `,
        }),
      });

      if (!sembleResponse.ok) {
        const errorBody = await sembleResponse.text();
        return NextResponse.json(
          {
            success: false,
            message: "Failed to fetch patients from Semble",
            status: sembleResponse.status,
            error: errorBody,
            page,
          },
          { status: 500 },
        );
      }

      const sembleData = await sembleResponse.json();
      const patients = sembleData?.data?.patients?.data ?? [];

      if (!Array.isArray(patients)) {
        return NextResponse.json(
          {
            success: false,
            message: "Unexpected Semble response format",
            page,
            sembleData,
          },
          { status: 500 },
        );
      }

      if (patients.length === 0) {
        break;
      }

      totalFetched += patients.length;

      for (const patient of patients) {
        const patientId = String(patient?.id ?? "");
        const patientName = `${patient?.firstName ?? ""} ${patient?.lastName ?? ""}`.trim();
        const phoneNumber = patient?.phones?.find(
          (phone: { phoneNumber?: string }) => Boolean(phone?.phoneNumber),
        )?.phoneNumber;

        if (!phoneNumber) {
          totalSkippedNoPhone += 1;
          continue;
        }

        const email = sanitizeEmail(patient?.email);
        const properties: Record<string, string> = {
          firstname: patient.firstName ?? "",
          lastname: patient.lastName ?? "",
          phone: phoneNumber,
          semble_patient_id: patientId,
        };

        try {
          if (!patientId) {
            throw new Error("Semble patient id is missing");
          }

          if (email) {
            properties.email = email;
          }

          let existingContactId = await searchContact([
            {
              propertyName: "semble_patient_id",
              operator: "EQ",
              value: patientId,
            },
          ]);
          let matchMethod: "semble_id" | "name_phone" | "name_email" | "new" = "new";

          if (existingContactId) {
            matchMethod = "semble_id";
          } else {
            existingContactId = await searchContact([
              {
                propertyName: "firstname",
                operator: "EQ",
                value: patient.firstName ?? "",
              },
              {
                propertyName: "lastname",
                operator: "EQ",
                value: patient.lastName ?? "",
              },
              {
                propertyName: "phone",
                operator: "EQ",
                value: phoneNumber,
              },
            ]);

            if (existingContactId) {
              matchMethod = "name_phone";
            } else if (email) {
              existingContactId = await searchContact([
                {
                  propertyName: "firstname",
                  operator: "EQ",
                  value: patient.firstName ?? "",
                },
                {
                  propertyName: "lastname",
                  operator: "EQ",
                  value: patient.lastName ?? "",
                },
                {
                  propertyName: "email",
                  operator: "EQ",
                  value: email,
                },
              ]);

              if (existingContactId) {
                matchMethod = "name_email";
              }
            }
          }

          if (existingContactId) {
            const updateResponse = await upsertWithEmailRetry(
              "PATCH",
              `https://api.hubapi.com/crm/v3/objects/contacts/${existingContactId}`,
              properties,
            );

            if (!updateResponse.ok) {
              const errorBody = await updateResponse.text();
              totalFailed += 1;
              failedPatients.push({
                patientId,
                name: patientName,
                email: email ?? null,
                phone: phoneNumber,
                status: updateResponse.status,
                error: errorBody || "Failed to update HubSpot contact",
              });
              continue;
            }

            if (matchMethod === "semble_id") {
              totalUpdatedBySembleId += 1;
            } else if (matchMethod === "name_phone") {
              totalMatchedByNamePhone += 1;
              totalBackfilled += 1;
            } else if (matchMethod === "name_email") {
              totalMatchedByNameEmail += 1;
              totalBackfilled += 1;
            }
          } else {
            const createResponse = await upsertWithEmailRetry(
              "POST",
              "https://api.hubapi.com/crm/v3/objects/contacts",
              properties,
            );

            if (!createResponse.ok) {
              const errorBody = await createResponse.text();
              totalFailed += 1;
              failedPatients.push({
                patientId,
                name: patientName,
                email: email ?? null,
                phone: phoneNumber,
                status: createResponse.status,
                error: errorBody || "Failed to create HubSpot contact",
              });
              continue;
            }

            totalCreated += 1;
          }
        } catch (error) {
          totalFailed += 1;
          failedPatients.push({
            patientId,
            name: patientName,
            email: email ?? null,
            phone: phoneNumber,
            status: null,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }

      page += 1;
    }
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: "Unexpected sync error",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    fetched: totalFetched,
    skippedNoPhone: totalSkippedNoPhone,
    updatedBySembleId: totalUpdatedBySembleId,
    matchedByNamePhone: totalMatchedByNamePhone,
    matchedByNameEmail: totalMatchedByNameEmail,
    backfilled: totalBackfilled,
    created: totalCreated,
    failed: totalFailed,
    failedPatients,
    pageSize,
    pagesProcessed: page - 1,
  });
}